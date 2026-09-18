/**
 * validator-context-safe-rules — #B398: `toFloat`, `set` and `format` must not
 * be context bombs.
 *
 * Pre-fix state, measured:
 *   - `toFloat` opened with an UNGUARDED `document.getElementById(...)` read,
 *     so every server-side call threw `ReferenceError: document is not
 *     defined` — for every input, valid ones included. The same statement was
 *     missing a comma, silently making `isFloatingWithCommas` an implicit
 *     global (the file is sloppy-mode).
 *   - `set` wrote `this.target.setAttribute(...)` unguarded; `target` is null
 *     server-side by construction, so every server-side call threw.
 *   - `format` called `val.format(mask, utc)` on whatever `this.value` held.
 *     After `isDate` that is a real `Date` and it works in BOTH contexts
 *     (`Date.prototype.format` IS installed server-side by helpers/prototypes
 *     — the "prototype extension absent server-side" reading was refuted by
 *     measurement). Without `isDate` first, the value is the raw string and
 *     the call threw the opaque `val.format is not a function` — in both
 *     contexts.
 *
 * Post-fix contract:
 *   - `toFloat` prefers the live DOM value when one is reachable (browser, or
 *     a harness stubbing `document` + `target`) and falls back to the
 *     submitted `this.value` otherwise — the server value IS the raw string,
 *     so the rule is fully functional server-side.
 *   - `set` assigns the value everywhere; the DOM reflection is browser-only.
 *   - `format` still returns the formatted STRING (documented, terminal); a
 *     non-Date value now throws a NAMED rule-authoring error pointing at the
 *     missing `isDate`, instead of the bare TypeError.
 *
 * Shape: behavioural runs of the REAL plugin over the server auto path (#B85
 * idiom, as in validator-nonstring-value-guards), plus direct-engine arms for
 * the fluent idiom and the DOM-stub discrimination (the stub arm supplies a
 * DOM value DIFFERENT from the field value, so it can actually fail — the
 * label-alias suite's stubs mirror the field value and cannot).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0);
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', { forms: null }); }
setContext('bundle', 'ctxsaferulesbundle');

var ENGINE_PATH = path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');
var Validator   = require(path.join(FW, 'core/plugins/lib/validator/src/main.js'));
var FormValidator = require(ENGINE_PATH);

// parseRules mutates its input — hand each run a fresh copy
function run(rules, data) {
    return Validator(JSON.parse(JSON.stringify(rules)), data, 'ctx-safe-form');
}
/** @returns {object} { threw, message?, isValid, errorKeys, data } for one rule-set/value pair */
function outcome(ruleObj, value) {
    try {
        var out = run({ f: ruleObj }, { f: value });
        return {
            threw: false,
            isValid: (out && typeof out.isValid === 'function') ? out.isValid() : null,
            errorKeys: (out && out.error && out.error.f) ? Object.keys(out.error.f) : [],
            data: out.data
        };
    } catch (e) { return { threw: true, message: String(e.message) }; }
}
/** Build a one-field validator; return the whole validator. */
function v(name, value) {
    var data = {};
    data[name] = value;
    return new FormValidator(data);
}
/** Run `fn(field)` with the browser DOM read stubbed to `domValue`; always unstubs. */
function withDocStub(field, domValue, fn) {
    global.document = {
        getElementById: function () { return { value: domValue }; }
    };
    field.target = { getAttribute: function () { return field.name; } };
    try {
        return fn(field);
    } finally {
        delete global.document;
    }
}


describe('01 - toFloat is context-safe (server auto path)', function () {

    it('a valid value coerces server-side instead of throwing', function () {
        var o = outcome({ toFloat: 2 }, '12.50');
        assert.equal(o.threw, false, 'must not throw: ' + (o.message || ''));
        assert.equal(o.isValid, true);
        assert.equal(o.data.f, 12.5);
    });

    it('a display-formatted value (thousand separator + comma decimal) normalizes server-side', function () {
        var o = outcome({ toFloat: 2 }, '1 234,56');
        assert.equal(o.threw, false, 'must not throw: ' + (o.message || ''));
        assert.equal(o.data.f, 1234.56);
    });

    it('a non-numeric value records the rule-keyed error, never a crash', function () {
        var o = outcome({ toFloat: 2 }, 'abc');
        assert.equal(o.threw, false, 'must not throw: ' + (o.message || ''));
        assert.equal(o.isValid, false);
        assert.ok(o.errorKeys.indexOf('toFloat') > -1, 'the error must be keyed to the rule');
    });
});


describe('02 - toFloat still prefers the live DOM value when one is reachable', function () {

    it('a reachable stubbed element WINS over the field value (the arm that can fail)', function () {
        // The field snapshot says 999; the "live DOM" says 12.50. Pre-#B398
        // the read was unconditional; the guard must keep preferring the live
        // value — a fallback-always regression flips this arm red.
        var val = v('price', '999');
        withDocStub(val.price, '12.50', function (f) { f.toFloat(2); });
        assert.equal(val.price.value, 12.5);
    });

    it('an EMPTY live value falls back to the field value (the original || semantics)', function () {
        var val = v('price', '12.50');
        withDocStub(val.price, '', function (f) { f.toFloat(2); });
        assert.equal(val.price.value, 12.5);
    });
});


describe('03 - set is context-safe (server auto path)', function () {

    it('assigns the value server-side instead of throwing', function () {
        var o = outcome({ set: 'forced' }, 'orig');
        assert.equal(o.threw, false, 'must not throw: ' + (o.message || ''));
        assert.equal(o.data.f, 'forced');
    });

    it('chains (returns the field object)', function () {
        var val = v('f', 'orig');
        var ret = val.f.set('next');
        assert.equal(ret, val.f);
        assert.equal(val.f.value, 'next');
    });
});


describe('04 - format: the documented isDate chain works in BOTH contexts', function () {

    it('CONTROL (green pre-fix too): declarative isDate + format does not throw server-side', function () {
        var o = outcome({ isDate: 'yyyy-mm-dd', format: 'isoDateTime' }, '2020-01-02');
        assert.equal(o.threw, false, 'must not throw: ' + (o.message || ''));
        assert.equal(o.isValid, true);
        // #B558: the payload is a calendar DATE, not an instant — the Date still
        // lives on the ENGINE field's .value, which is what `format` consumes.
        assert.equal(o.data.f, '2020-01-02');
    });

    it('CONTROL: the fluent idiom returns the formatted string server-side (Date.prototype.format IS installed)', function () {
        // This is the measured refutation of the "prototype extension absent
        // server-side" reading: helpers/index installs PrototypesHelper with
        // dateFormat unconditionally, so the documented idiom works on the
        // server exactly as in the browser.
        var val = v('start', '2020-01-02');
        var out = val.start.isDate('yyyy-mm-dd').format('isoDateTime');
        assert.equal(typeof out, 'string');
        assert.match(out, /^2020-01-02T/);
    });

    it('CONTROL: a falsy value still takes the early chain return', function () {
        var val = v('d', '');
        assert.equal(val.d.format('isoDateTime'), val.d);
    });
});


describe('05 - format: a non-Date value throws the NAMED authoring error', function () {

    it('declarative format without isDate names the rule, the field and the fix', function () {
        var o = outcome({ format: 'isoDateTime' }, '2020-01-02');
        assert.equal(o.threw, true, 'a non-Date value is a rule-authoring error and must throw');
        assert.match(o.message, /\[FormValidator::format\]/,
            'the named error must survive the driver rethrow');
        assert.match(o.message, /`f`/, 'must name the field');
        assert.match(o.message, /apply isDate\(mask\) before format\(mask\)/, 'must name the fix');
    });

    it('fluent form throws the same named error', function () {
        var val = v('f', 'not-a-date-object');
        assert.throws(function () { val.f.format('isoDateTime'); },
            /\[FormValidator::format\].*apply isDate\(mask\) before format\(mask\)/);
    });
});


describe('06 - dist fidelity: the named error reached the built browser bundle', function () {
    // toFloat's and set's fixes add no string literal that survives
    // minification (guards only), so their dist propagation is locked by the
    // Bundle Freshness CI gate; the format message is the one greppable
    // discriminator this fix ships. Counted with match(), never grep -c —
    // the artifact is near-single-line.
    var NEEDLE = /value is not a Date - apply isDate\(mask\) before format\(mask\)/;

    it('gina.js carries the named format error', function () {
        var raw = fs.readFileSync(path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js'), 'utf8');
        assert.match(raw, NEEDLE);
    });

    it('gina.min.js carries the named format error', function () {
        var min = fs.readFileSync(path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js'), 'utf8');
        assert.match(min, NEEDLE);
    });
});
