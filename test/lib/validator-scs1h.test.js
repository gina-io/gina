'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
var FORM_VAL_SRC = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/form-validator.js'), 'utf8');

// --- Test-local replica of the post-#M21b code shape (the else branch in the
// condition-evaluator fallback at form-validator.js:~1063-1078). Mirrors the
// source verbatim so the source-inspection block in section 03 double-locks
// the replica against drift.

var evaluateConditionElseBranch = function (condition, value) {
    var isValid;
    var re, flags;
    try {
        if (/\/(.*)\//.test(condition)) {
            re    = condition.match(/\/(.*)\//).pop();
            flags = condition.replace('/' + re + '/', '');
            isValid = new RegExp(re, flags).test(value);
        } else {
            throw new Error('[FormValidator] Unsupported condition shape — supported: binary comparison (a OP b), RegExp, boolean, /regex/flags literal. Got: `' + condition + '`');
        }
    } catch (err) {
        throw new Error(err.stack || err.message);
    }
    return isValid;
};

var stripComments = function (src) {
    return commentStrip.lines(src);
};


// --- 01 — supported condition shapes still pass through ---
describe('01 — supported condition shapes (#M21b)', function () {

    it('regex-literal string matches its value (no flags)', function () {
        var result = evaluateConditionElseBranch('/^abc$/', 'abc');
        assert.equal(result, true);
    });

    it('regex-literal string with flags', function () {
        var result = evaluateConditionElseBranch('/^abc$/i', 'ABC');
        assert.equal(result, true);
    });

    it('regex-literal string that does not match', function () {
        var result = evaluateConditionElseBranch('/^abc$/', 'xyz');
        assert.equal(result, false);
    });

    it('regex-literal string with anchor metachars', function () {
        var result = evaluateConditionElseBranch('/\\d+/', 'abc123');
        assert.equal(result, true);
    });
});


// --- 02 — unsupported (free-form JS expression) shape now throws ---
describe('02 — unsupported condition shape throws (#M21b)', function () {

    it('a bare JS expression that previously eval-evaluated now throws', function () {
        assert.throws(
            function () { evaluateConditionElseBranch('1 + 1 === 2', 'irrelevant'); },
            /\[FormValidator\] Unsupported condition shape/
        );
    });

    it('the thrown error names the supported shapes verbatim', function () {
        var captured = null;
        try {
            evaluateConditionElseBranch('arbitraryThing()', 'v');
        } catch (e) {
            captured = e;
        }
        assert.ok(captured, 'expected the call to throw');
        assert.match(captured.message, /binary comparison \(a OP b\)/);
        assert.match(captured.message, /RegExp/);
        assert.match(captured.message, /boolean/);
        assert.match(captured.message, /\/regex\/flags literal/);
    });

    it('the thrown error includes the offending condition verbatim', function () {
        var captured = null;
        try {
            evaluateConditionElseBranch('mysteryFn(form, data)', 'v');
        } catch (e) {
            captured = e;
        }
        assert.ok(captured, 'expected the call to throw');
        assert.ok(captured.message.indexOf('mysteryFn(form, data)') !== -1);
    });

    it('the outer catch re-throws (preserves the stack or message)', function () {
        var captured = null;
        try {
            evaluateConditionElseBranch('foo', 'v');
        } catch (e) {
            captured = e;
        }
        assert.ok(captured instanceof Error);
        assert.ok(captured.message.length > 0);
    });

    it('an empty-string condition (edge) also throws with the documented marker', function () {
        assert.throws(
            function () { evaluateConditionElseBranch('', 'v'); },
            /\[FormValidator\] Unsupported condition shape/
        );
    });
});


// --- 03 — source-inspection guards ---
describe('03 — #M21b source-inspection guards', function () {

    it('form-validator.js: zero live eval(condition) calls remain', function () {
        // Strip line and block comments before checking. The pre-#SCS1e and
        // pre-#M21b commented-out `eval(...)` lines must not register as live.
        var live = stripComments(FORM_VAL_SRC);
        assert.ok(
            !/\beval\s*\(\s*condition\s*\)/.test(live),
            'live form-validator.js still contains eval(condition)'
        );
    });

    it('form-validator.js: the documented-shape throw is present in the fallback else branch', function () {
        // The replacement throws with a stable marker string.
        var marker = /throw new Error\(\s*['"]\[FormValidator\] Unsupported condition shape/;
        assert.ok(
            marker.test(FORM_VAL_SRC),
            'documented-shape throw missing from form-validator.js'
        );
    });

    it('form-validator.js: throw message lists the four supported shapes verbatim', function () {
        assert.ok(/binary comparison \(a OP b\)/.test(FORM_VAL_SRC), 'binary-comparison phrase missing');
        assert.ok(/RegExp/.test(FORM_VAL_SRC), 'RegExp phrase missing');
        assert.ok(/boolean/.test(FORM_VAL_SRC), 'boolean phrase missing');
        assert.ok(/\/regex\/flags literal/.test(FORM_VAL_SRC), 'regex-literal phrase missing');
    });

    it('form-validator.js: carries the #M21b provenance tag', function () {
        assert.ok(/#M21b/.test(FORM_VAL_SRC), '#M21b tag should be present in form-validator.js');
    });

    it('form-validator.js: regex-literal branch (the surviving supported shape) is preserved', function () {
        // The if-branch above the dropped eval remains intact: `if (/\/(.*)\//.test(condition))`
        // → extract body + flags → new RegExp(...).test(this.value)
        assert.ok(
            /if\s*\(\s*\/\\\/\(\.\*\)\\\/\/.test\s*\(\s*condition\s*\)\s*\)/.test(FORM_VAL_SRC),
            'regex-literal detection if-branch missing or altered'
        );
        assert.ok(
            /isValid\s*=\s*new\s+RegExp\s*\(\s*re\s*,\s*flags\s*\)\.test\s*\(\s*this\.value\s*\)/.test(FORM_VAL_SRC),
            'regex-literal RegExp.test(this.value) call missing'
        );
    });
});
