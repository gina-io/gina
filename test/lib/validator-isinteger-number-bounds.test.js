'use strict';
/**
 * #B198 — `isInteger`'s digit bounds must fire on a real Number, not only on a string
 *
 * The defect: `isInteger` accepted a real `Number` (its type gate is
 * `+val === +val && val % 1 === 0`, which a Number passes) and then measured
 * `val.length` to test the optional `minLength` / `maxLength` bounds.
 * `Number.prototype.length` is `undefined`, and `undefined < min` / `undefined > max`
 * are both `false`, so BOTH bounds recorded no error, emitted no warn, and left the
 * field `valid: true` — a validation bypass that fails OPEN. The sibling `isNumber`
 * measures `val.toString().length` and was always correct (it also casts first, which
 * `isInteger` deliberately does not).
 *
 * Why a Number reaches this rule at all — all three paths are real:
 *   (a) JSON request bodies stay real Numbers (`core/server.js` JSON.parse →
 *       `request.body` = `request.post`), and the routing `validator::{}` path merges
 *       that body into the validated data (`lib/routing/src/main.js`) before spreading
 *       array bounds through `apply()`;
 *   (b) `toInteger` leaves `Math.round()`'s real Number on `this.value`, so a
 *       `toInteger` → `isInteger` chain is affected IN THE BROWSER TOO — the original
 *       by-catch note reasoned "DOM values are always strings ⇒ browser safe", which
 *       § 05 below measures false;
 *   (c) a hand-written server-side validation driver passing parsed values.
 *
 * COVERAGE GAP THIS FILE CLOSES: the pre-existing suites exercise the bounds only with
 * STRING values (`validator-engine-rules.test.js` § 04, `validator-label-alias.test.js`
 * § 02), where `val.length === val.toString().length` so the defect is invisible; the
 * one real-Number arm that exists (`validator-engine-rules.test.js`, `vf('n', 12)
 * .isInteger()`) passes NO bounds, so the `minLength &&` guard short-circuits before
 * `.length` is ever read. "A real Number COMBINED WITH bounds" was untested.
 *
 * SCOPING (§ 02) — `isString` uses the identical `val.length` expression at two sites
 * but is guarded by `typeof(val) == 'string'`, so it is NOT defective and MUST stay
 * unchanged. A whole-file needle for the bound expression matches four sites, two of
 * them isString's; the fix is line-scoped and this file pins that.
 *
 * Bootstrap mirrors `validator-engine-rules.test.js`: `require(<fw>/helpers)` injects
 * the framework globals, then `gina` is seeded so the constructor's user-validator
 * probe is a no-op.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0); // engine construction adds logger listeners per instance
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', {}); }

var ENGINE_PATH = path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');
var ENGINE_SRC  = fs.readFileSync(ENGINE_PATH, 'utf8');
var FormValidator = require(ENGINE_PATH);
var commentStrip = require('../strip-comments');

/**
 * Build a one-field validator and return that field object (carrying the chainable
 * rule methods + `.valid` / `.errors`).
 * @param {string} name
 * @param {*} value
 * @returns {object} the field object
 */
function vf(name, value) {
    var data = {};
    data[name] = value;
    return new FormValidator(data)[name];
}

/**
 * Assert the field validated cleanly (no error recorded).
 * @param {object} field
 * @param {string} [ msg ]
 */
function ok(field, msg) {
    assert.equal(field.valid, true, msg || 'expected valid');
    assert.equal(typeof field.errors, 'undefined', 'expected no errors object on a valid field');
}

/**
 * Assert the field failed and recorded `errorKey`.
 * @param {object} field
 * @param {string} errorKey
 * @param {string} [ msg ]
 */
function ko(field, errorKey, msg) {
    assert.equal(field.valid, false, msg || 'expected invalid');
    assert.ok(
        field.errors && typeof field.errors[errorKey] === 'string',
        (msg || 'expected an error') + ' — expected errors[' + errorKey + '], got ' +
            JSON.stringify(field.errors)
    );
}


// 01 — source pins: the fix is present, and it is LINE-SCOPED
describe('01 - source: isInteger measures the string form, isString is untouched', function () {

    /**
     * Slice the source between two rule definitions so a pin cannot accidentally
     * match a sibling rule's identical expression.
     * @param {string} ruleName
     * @returns {string} the rule body
     */
    function bodyOf(ruleName) {
        var start = ENGINE_SRC.indexOf("self[el]['" + ruleName + "'] = function");
        assert.ok(start > -1, 'rule ' + ruleName + ' not found in the engine source');
        var next = ENGINE_SRC.indexOf("self[el]['", start + 10);
        return ENGINE_SRC.slice(start, next > -1 ? next : ENGINE_SRC.length);
    }

    it('isInteger tests BOTH bounds against val.toString().length', function () {
        var body = bodyOf('isInteger');
        assert.match(
            body,
            /minLength\s*&&\s*typeof\(minLength\)\s*==\s*'number'\s*&&\s*val\.toString\(\)\.length\s*<\s*minLength/,
            'isInteger minLength bound must measure val.toString().length'
        );
        assert.match(
            body,
            /maxLength\s*&&\s*typeof\(maxLength\)\s*==\s*'number'\s*&&\s*val\.toString\(\)\.length\s*>\s*maxLength/,
            'isInteger maxLength bound must measure val.toString().length'
        );
    });

    it('isInteger no longer reads a bare val.length in EXECUTABLE code', function () {
        // Strip comments first: the fix ships a `// #B198 - was: val.length` note and
        // the JSDoc explains the defect, so a naive text scan matches prose and can
        // never go green. The claim under test is about code, so the instrument must
        // measure code — this pin was rewritten after it fired on its own comment.
        var body = commentStrip.all(bodyOf('isInteger'))
            .replace(/val\.toString\(\)\.length/g, ''); // not a bare hit
        assert.ok(
            body.indexOf('val.length') < 0,
            'isInteger still reads a bare val.length in executable code — the fix is incomplete'
        );
    });

    it('CONTROL: isString still measures val.length (guarded by a typeof check, NOT defective)', function () {
        var body = bodyOf('isString');
        assert.match(body, /typeof\(val\)\s*==\s*'string'/, 'isString must keep its type guard');
        assert.match(
            body,
            /minLength\s*&&\s*typeof\(minLength\)\s*==\s*'number'\s*&&\s*val\.length\s*<\s*minLength/,
            'isString minLength must stay val.length — a global replace would break this pin'
        );
        assert.match(
            body,
            /maxLength\s*&&\s*typeof\(maxLength\)\s*==\s*'number'\s*&&\s*val\.length\s*>\s*maxLength/,
            'isString maxLength must stay val.length — a global replace would break this pin'
        );
    });

    it('CONTROL: isNumber keeps its own toString().length measurement', function () {
        assert.match(bodyOf('isNumber'), /len\s*=\s*val\.toString\(\)\.length/);
    });
});


// 02 — the defect: bounds on a real Number
describe('02 - isInteger bounds fire on a real Number', function () {

    it('minLength fires on a real Number below the bound', function () {
        ko(vf('n', 123).isInteger(5), 'isIntegerLength', 'min-5 on the Number 123');
    });

    it('CONTROL: the same bound on the equivalent STRING fires (it always did)', function () {
        ko(vf('n', '123').isInteger(5), 'isIntegerLength', 'min-5 on the string "123"');
    });

    it('maxLength fires on a real Number above the bound', function () {
        ko(vf('n', 12345).isInteger(0, 2), 'isIntegerLength', 'max-2 on the Number 12345');
    });

    it('CONTROL: the same max bound on the equivalent STRING fires', function () {
        ko(vf('n', '12345').isInteger(0, 2), 'isIntegerLength', 'max-2 on the string "12345"');
    });

    it('the exact-length branch (minLength === maxLength) fires on a real Number', function () {
        ko(vf('n', 12345).isInteger(3, 3), 'isIntegerLength', 'exact-3 on the Number 12345');
    });

    it('an in-range real Number still passes (no false positive)', function () {
        ok(vf('n', 12345).isInteger(5), 'min-5 on the Number 12345 is in range');
        ok(vf('n', 1234).isInteger(2, 4), 'range [2,4] on the Number 1234 is in range');
    });

    it('a Number with no bounds declared is unaffected (guards short-circuit)', function () {
        ok(vf('n', 123).isInteger(), 'no bounds: nothing to enforce');
    });
});


// 03 — the browser-reachable path: toInteger leaves a real Number
describe('03 - toInteger -> isInteger: bounds survive the coercion', function () {

    it('a STRING coerced by toInteger still has its bounds enforced', function () {
        ko(vf('n', '123').toInteger().isInteger(5), 'isIntegerLength',
            'toInteger leaves Math.round()\'s real Number on this.value; bounds must still fire');
    });

    it('CONTROL: the same input WITHOUT toInteger fires too (single-variable pair)', function () {
        ko(vf('n', '123').isInteger(5), 'isIntegerLength');
    });

    it('an in-range value through the same chain still passes', function () {
        ok(vf('n', '12345').toInteger().isInteger(5));
    });

    it('toInteger really does leave a typeof "number" on the field', function () {
        var field = vf('n', '123').toInteger();
        assert.equal(typeof field.value, 'number', 'toInteger must leave a real Number');
    });
});


// 04 — sibling rules must be byte-identical in behavior
describe('04 - CONTROLS: isNumber and isString are unaffected by the fix', function () {

    it('isNumber fires on BOTH a string and a real Number (it always did)', function () {
        ko(vf('n', '123').isNumber(5), 'isNumberLength');
        ko(vf('n', 123).isNumber(5), 'isNumberLength');
    });

    it('isString bounds still behave as before', function () {
        ko(vf('s', 'abc').isString(7), 'isStringLength');
        ok(vf('s', 'abcdefg').isString(7, 7));
    });
});


// 05 — deltas this fix deliberately introduces (disclosed in the changelog/migration)
describe('05 - DISCLOSED behavior changes', function () {

    it('a NEGATIVE Number counts its sign — parity with the string arm, which always did', function () {
        // '-123'.length === 4, so min-5 fails on BOTH forms after the fix.
        ko(vf('n', -123).isInteger(5), 'isIntegerLength', 'the Number -123');
        ko(vf('n', '-123').isInteger(5), 'isIntegerLength', 'the string "-123" (unchanged by the fix)');
    });

    it('the bound counts CHARACTERS of the string form, so the sign is included', function () {
        // -1234 renders as 5 characters; an exact-5 bound therefore passes.
        ok(vf('n', -1234).isInteger(5, 5), 'the sign occupies one of the five characters');
    });
});


// 06 — the #B198 residual, CLOSED by #B199 (sanctioned flip: this section was
// written to pin the residual and flip when the strict-gate decision landed —
// its original title said "not closed by #B198" for exactly this reason).
describe('06 - #B199: the bounds gate no longer swallows the Number 0', function () {

    it('the Number 0 hits the bounds (the loose != \'\' swallow is gone)', function () {
        // Pre-#B199: `0 != ''` was FALSE (loose coercion), so the whole bound
        // block was skipped for 0. Strict !== ends the conflation.
        ko(vf('n', 0).isInteger(2), 'isIntegerLength');
    });

    it('CONTROL: the STRING "0" hits the bounds (it always did)', function () {
        ko(vf('n', '0').isInteger(2), 'isIntegerLength');
    });

    it('isNumber is healed identically — including its coerced string "0"', function () {
        ko(vf('n', 0).isNumber(2), 'isNumberLength');
        // isNumber casts '0' -> 0 on ENTRY, so pre-#B199 even the string form
        // was swallowed there (unlike isInteger, which never casts on entry).
        ko(vf('n', '0').isNumber(2), 'isNumberLength');
    });

    it('a non-zero single-digit Number fires, and the EMPTY STRING still bypasses (the designed contract)', function () {
        ko(vf('n', 5).isInteger(2), 'isIntegerLength');
        // '' stays adjudicated by isRequired alone (#B78) — strict preserves it.
        ok(vf('n', '').isInteger(2), 'the literal empty string keeps its bypass');
    });
});
