'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW             = require('../fw');
var MAIN_SRC       = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/main.js'), 'utf8');
var FORM_VAL_SRC   = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/form-validator.js'), 'utf8');

// --- Test-local copies of the primitives used at the four refactored sites. ---
// These MUST mirror the inline code in the source files exactly. Behavioural
// tests below verify that the primitives produce the same output as the
// pre-refactor `eval(...)` calls would have, on the empirical corpus. Source
// inspection in the last describe block locks the source-file shape.

// Dot-path walker — replaces `eval('gina.forms.rules.' + customRule)` at
// main.js:2603 and (conceptually) the prefix case of :161.
var walkDotPath = function (root, path) {
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(path)) {
        throw new Error('Invalid form rule path: `' + path + '`');
    }
    var segments = path.split('.');
    var cur = root;
    for (var i = 0; cur != null && i < segments.length; i++) {
        cur = cur[segments[i]];
    }
    return cur;
};

// Dot+bracket walker — replaces `eval('data.' + localValue)` at
// form-validator.js:161 after the `{` / `}` / `[` / `]` transforms at
// lines 152-158.
var walkDotBracket = function (root, path) {
    var rest = path;
    var segments = [];
    var m = rest.match(/^([A-Za-z_$][\w$]*)/);
    if (!m) { throw new Error('Invalid property path: `' + path + '`'); }
    segments.push(m[1]);
    rest = rest.slice(m[0].length);
    while (rest.length > 0) {
        m = rest.match(/^\.([A-Za-z_$][\w$]*)/);
        if (m) {
            segments.push(m[1]);
            rest = rest.slice(m[0].length);
            continue;
        }
        m = rest.match(/^\["([^"\]]*)"\]/);
        if (m) {
            segments.push(m[1]);
            rest = rest.slice(m[0].length);
            continue;
        }
        throw new Error('Invalid property path: `' + path + '`');
    }
    var cur = root;
    for (var i = 0; cur != null && i < segments.length; i++) {
        cur = cur[segments[i]];
    }
    return cur;
};

// Regex-literal test helper — replaces
// `eval(compiledCondition + '.test("' + value + '")')` at form-validator.js:893.
var testRegexLiteral = function (compiledCondition, value) {
    var m = compiledCondition.match(/^\/(.+)\/([a-z]*)$/);
    if (!m) { throw new Error('Invalid regex literal: `' + compiledCondition + '`'); }
    return new RegExp(m[1], m[2]).test(value);
};

// Binary-compare evaluator — replaces `eval(compiledCondition)` at
// form-validator.js:895.
var BINARY_RE = /^\s*(null|undefined|true|false|"[^"]*"|-?\d+(?:\.\d+)?)\s*(===|!==|<=|>=|==|!=|<|>)\s*(null|undefined|true|false|"[^"]*"|-?\d+(?:\.\d+)?)\s*$/;
var parseBinaryOperand = function (s) {
    var t = s.replace(/^\s+|\s+$/g, '');
    if (t === 'null')      return null;
    if (t === 'undefined') return undefined;
    if (t === 'true')      return true;
    if (t === 'false')     return false;
    if (/^"[^"]*"$/.test(t)) return t.slice(1, -1);
    var n = Number(t);
    if (!isNaN(n) && t !== '') return n;
    throw new Error('Invalid operand: `' + s + '`');
};
var evalBinaryCondition = function (condition) {
    var m = (typeof(condition) === 'string') ? condition.match(BINARY_RE) : null;
    if (!m) {
        throw new Error('Could not evaluate condition `' + condition + '`');
    }
    var left  = parseBinaryOperand(m[1]);
    var op    = m[2];
    var right = parseBinaryOperand(m[3]);
    switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        case '==':  return left ==  right;
        case '!=':  return left !=  right;
        case '<':   return left <   right;
        case '>':   return left >   right;
        case '<=':  return left <=  right;
        case '>=':  return left >=  right;
    }
};


// --- 01 — Dot-path walker (main.js:2603) ---
// Empirical corpus: real `data-gina-form-rule` attribute values from
// ~/Sites/<consumer-app>/src/ (15 distinct values observed 2026-04-24, all
// transform to pure dot-paths after the `.replace(/\-|\//g, '.')` at :2601).
describe('01 — dot-path walker (main.js:2603 replacement)', function () {

    var rules = {
        account: { signin_scope: { username: { isEmail: true } } },
        contact: { bug: { description: { isString: true } } },
        document: {
            create_template: { name: { isRequired: true } },
            payment_collection: { amount: { isNumber: true } }
        },
        setting: {
            design: { theme: { isString: true } },
            units: { edit: { code: { isRequired: true } } }
        }
    };

    it('walks `account.signin_scope`', function () {
        assert.deepStrictEqual(walkDotPath(rules, 'account.signin_scope'), { username: { isEmail: true } });
    });

    it('walks `contact.bug`', function () {
        assert.deepStrictEqual(walkDotPath(rules, 'contact.bug'), { description: { isString: true } });
    });

    it('walks `document.create_template` (contains underscore)', function () {
        assert.deepStrictEqual(walkDotPath(rules, 'document.create_template'), { name: { isRequired: true } });
    });

    it('walks `setting.units.edit` (three-segment)', function () {
        assert.deepStrictEqual(walkDotPath(rules, 'setting.units.edit'), { code: { isRequired: true } });
    });

    it('returns undefined for missing path', function () {
        assert.equal(walkDotPath(rules, 'account.nonexistent'), undefined);
    });

    it('returns undefined mid-path (null-safe)', function () {
        assert.equal(walkDotPath(rules, 'account.signin_scope.username.nope.deeper'), undefined);
    });
});

// --- 02 — Dot-path walker rejects injection vectors ---
describe('02 — dot-path walker rejects injection (main.js:2603)', function () {

    var rules = { a: { b: 1 } };

    it('rejects `constructor.constructor("return 1")()`', function () {
        assert.throws(
            function () { walkDotPath(rules, 'constructor.constructor("return 1")()'); },
            /Invalid form rule path/
        );
    });

    it('rejects path with parens', function () {
        assert.throws(function () { walkDotPath(rules, 'a.b()'); }, /Invalid form rule path/);
    });

    it('rejects path with brackets', function () {
        assert.throws(function () { walkDotPath(rules, 'a[b]'); }, /Invalid form rule path/);
    });

    it('rejects path with semicolon', function () {
        assert.throws(function () { walkDotPath(rules, 'a;process.exit()'); }, /Invalid form rule path/);
    });

    it('rejects empty path', function () {
        assert.throws(function () { walkDotPath(rules, ''); }, /Invalid form rule path/);
    });

    it('rejects leading dot', function () {
        assert.throws(function () { walkDotPath(rules, '.a'); }, /Invalid form rule path/);
    });

    it('rejects trailing dot', function () {
        assert.throws(function () { walkDotPath(rules, 'a.'); }, /Invalid form rule path/);
    });
});

// --- 03 — Dot+bracket walker (form-validator.js:161) ---
// The consumer-app has zero `{{...}}` placeholders in forms/rules/*.json (corpus
// verified 2026-04-24). The shapes exercised here cover the transform output
// at form-validator.js:152-158: `ident (. ident | ["quoted"])*`.
describe('03 — dot+bracket walker (form-validator.js:161 replacement)', function () {

    it('walks bare identifier — `name`', function () {
        assert.equal(walkDotBracket({ name: 'alice' }, 'name'), 'alice');
    });

    it('walks dotted path — `user.id`', function () {
        assert.equal(walkDotBracket({ user: { id: 42 } }, 'user.id'), 42);
    });

    it('walks bracket segment — `account["firstName"]`', function () {
        assert.equal(walkDotBracket({ account: { firstName: 'Ada' } }, 'account["firstName"]'), 'Ada');
    });

    it('walks mixed — `user.contact["email"]`', function () {
        assert.equal(walkDotBracket({ user: { contact: { email: 'a@b.c' } } }, 'user.contact["email"]'), 'a@b.c');
    });

    it('walks bracket with numeric-looking key — `item.details["0"]`', function () {
        assert.equal(walkDotBracket({ item: { details: { '0': 'zero' } } }, 'item.details["0"]'), 'zero');
    });

    it('walks hyphenated bracket key — `config["my-key"]`', function () {
        assert.equal(walkDotBracket({ config: { 'my-key': 'value' } }, 'config["my-key"]'), 'value');
    });

    it('returns undefined for missing key', function () {
        assert.equal(walkDotBracket({ user: {} }, 'user.name'), undefined);
    });

    it('returns undefined when walking through undefined (null-safe)', function () {
        assert.equal(walkDotBracket({}, 'a.b.c'), undefined);
    });
});

// --- 04 — Dot+bracket walker rejects injection vectors ---
describe('04 — dot+bracket walker rejects injection (form-validator.js:161)', function () {

    var data = { a: { b: 1 } };

    it('rejects unclosed bracket', function () {
        assert.throws(function () { walkDotBracket(data, 'a["b'); }, /Invalid property path/);
    });

    it('rejects bracket without quotes', function () {
        assert.throws(function () { walkDotBracket(data, 'a[b]'); }, /Invalid property path/);
    });

    it('rejects method-call syntax', function () {
        assert.throws(function () { walkDotBracket(data, 'a.b()'); }, /Invalid property path/);
    });

    it('rejects constructor-call escape', function () {
        // `constructor["constructor"]` walks cleanly to `Function` (harmless
        // getter). The injection shape that actually executes JS under old
        // eval is `constructor["constructor"]("return 1")()`; the walker
        // rejects `(` as not-`.ident`/not-`["..."]`.
        assert.throws(
            function () { walkDotBracket(data, 'constructor["constructor"]("return 1")()'); },
            /Invalid property path/
        );
    });

    it('rejects bracket with embedded quote', function () {
        assert.throws(function () { walkDotBracket(data, 'a["b"c"]'); }, /Invalid property path/);
    });

    it('rejects leading `.`', function () {
        assert.throws(function () { walkDotBracket(data, '.a'); }, /Invalid property path/);
    });

    it('rejects leading `[`', function () {
        assert.throws(function () { walkDotBracket(data, '["a"]'); }, /Invalid property path/);
    });
});

// --- 05 — Regex-literal test helper (form-validator.js:893) ---
// Empirical corpus: real `is` field values from consumer-app forms/rules/*.json
// (15 distinct regex literals observed 2026-04-24).
describe('05 — regex-literal test helper (form-validator.js:893 replacement)', function () {

    it('tests case-insensitive alternation — `/^(single|balance|deposit)$/i`', function () {
        assert.equal(testRegexLiteral('/^(single|balance|deposit)$/i', 'Balance'), true);
        assert.equal(testRegexLiteral('/^(single|balance|deposit)$/i', 'refund'), false);
    });

    it('tests UUID pattern — `/^[0-9a-f]{8}-[0-9a-f]{4}.../i`', function () {
        var re = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';
        assert.equal(testRegexLiteral(re, '12345678-1234-1234-8abc-123456789012'), true);
        assert.equal(testRegexLiteral(re, 'not-a-uuid'), false);
    });

    it('tests match-anywhere — `/(estimate|invoice|creditNote)/i`', function () {
        assert.equal(testRegexLiteral('/(estimate|invoice|creditNote)/i', 'my-Invoice-2024'), true);
        assert.equal(testRegexLiteral('/(estimate|invoice|creditNote)/i', 'receipt'), false);
    });

    it('tests no-flags regex — `/^(rate|value)$/`', function () {
        assert.equal(testRegexLiteral('/^(rate|value)$/', 'rate'), true);
        assert.equal(testRegexLiteral('/^(rate|value)$/', 'RATE'), false);
    });

    it('throws on non-regex input', function () {
        assert.throws(function () { testRegexLiteral('not a regex', 'x'); }, /Invalid regex literal/);
    });

    it('throws on unclosed regex', function () {
        assert.throws(function () { testRegexLiteral('/unclosed', 'x'); }, /Invalid regex literal/);
    });
});

// --- 06 — Binary-compare evaluator (form-validator.js:895) ---
// Empirical corpus: real `is` array-form conditions from consumer-app
// forms/rules/*.json (11 distinct conditions observed 2026-04-24, all binary
// comparisons after `$var` substitution + paren-strip).
describe('06 — binary-compare evaluator (form-validator.js:895 replacement)', function () {

    it('evaluates `100 <= 100` → true', function () {
        assert.equal(evalBinaryCondition('100 <= 100'), true);
    });

    it('evaluates `50 <= 100` → true', function () {
        assert.equal(evalBinaryCondition('50 <= 100'), true);
    });

    it('evaluates `150 <= 100` → false', function () {
        assert.equal(evalBinaryCondition('150 <= 100'), false);
    });

    it('evaluates `"pwd" === "pwd"` → true (password match case)', function () {
        assert.equal(evalBinaryCondition('"pwd" === "pwd"'), true);
    });

    it('evaluates `"pwd" === "other"` → false', function () {
        assert.equal(evalBinaryCondition('"pwd" === "other"'), false);
    });

    it('evaluates `true == true` → true (confirm-boolean case)', function () {
        assert.equal(evalBinaryCondition('true == true'), true);
    });

    it('evaluates `true === true` → true', function () {
        assert.equal(evalBinaryCondition('true === true'), true);
    });

    it('evaluates `false == true` → false', function () {
        assert.equal(evalBinaryCondition('false == true'), false);
    });

    it('evaluates `null === null` → true', function () {
        assert.equal(evalBinaryCondition('null === null'), true);
    });

    it('evaluates `undefined === undefined` → true', function () {
        assert.equal(evalBinaryCondition('undefined === undefined'), true);
    });

    it('evaluates decimal comparison — `1.5 < 2.5` → true', function () {
        assert.equal(evalBinaryCondition('1.5 < 2.5'), true);
    });

    it('evaluates negative number — `-5 < 0` → true', function () {
        assert.equal(evalBinaryCondition('-5 < 0'), true);
    });

    it('tolerates whitespace — `  "a"   ===   "a"  ` → true', function () {
        assert.equal(evalBinaryCondition('  "a"   ===   "a"  '), true);
    });
});

// --- 07 — Binary-compare evaluator rejects injection ---
describe('07 — binary-compare rejects injection (form-validator.js:895)', function () {

    it('rejects semicolon injection — `"x" === "x"; process.exit()`', function () {
        assert.throws(
            function () { evalBinaryCondition('"x" === "x"; process.exit()'); },
            /Could not evaluate condition/
        );
    });

    it('rejects throw injection — `0 > -1; throw new Error("PWND")`', function () {
        assert.throws(
            function () { evalBinaryCondition('0 > -1; throw new Error("PWND")'); },
            /Could not evaluate condition/
        );
    });

    it('rejects arithmetic — `1 + 2 > 0`', function () {
        assert.throws(function () { evalBinaryCondition('1 + 2 > 0'); }, /Could not evaluate condition/);
    });

    it('rejects function call — `alert("x") === true`', function () {
        assert.throws(
            function () { evalBinaryCondition('alert("x") === true'); },
            /Could not evaluate condition/
        );
    });

    it('rejects bare identifier — `process === undefined`', function () {
        // `process` as a bare identifier isn't in the operand grammar.
        assert.throws(
            function () { evalBinaryCondition('process === undefined'); },
            /Could not evaluate condition/
        );
    });

    it('rejects unquoted string-like — `abc === abc`', function () {
        assert.throws(function () { evalBinaryCondition('abc === abc'); }, /Could not evaluate condition/);
    });

    it('rejects single-operand input — `true`', function () {
        assert.throws(function () { evalBinaryCondition('true'); }, /Could not evaluate condition/);
    });

    it('rejects three-operand input — `1 < 2 < 3`', function () {
        assert.throws(function () { evalBinaryCondition('1 < 2 < 3'); }, /Could not evaluate condition/);
    });

    it('rejects non-string input — 42', function () {
        assert.throws(function () { evalBinaryCondition(42); }, /Could not evaluate condition/);
    });
});

// --- 08 — Regex-test helper rejects injection ---
describe('08 — regex-test rejects injection (form-validator.js:893)', function () {

    // Note: since #B345 the paren/`return` strip runs only in the binary-
    // comparison branch, so parentheses DO reach the regex parser as authored.
    // What constrains this branch is the grammar lock (`/^\/(.+)\/([a-z]*)$/`)
    // plus `new RegExp(body, flags).test(value)` — never eval — so `);alert()//`
    // and friends are inert pattern text. The shapes below stay rejected by the
    // grammar itself.

    it('rejects empty body — `//`', function () {
        assert.throws(function () { testRegexLiteral('//', 'x'); }, /Invalid regex literal/);
    });

    it('rejects missing leading slash', function () {
        assert.throws(function () { testRegexLiteral('body/', 'x'); }, /Invalid regex literal/);
    });

    it('rejects uppercase flags (not valid JS regex flags)', function () {
        // `/foo/G` — `G` is not in `[a-z]*`; parser rejects.
        assert.throws(function () { testRegexLiteral('/foo/G', 'x'); }, /Invalid regex literal/);
    });
});

// --- 09 — Source-inspection guards (like collection.test.js §06) ---
describe('09 — #SCS1e source-inspection guards', function () {

    // Strip `//` line comments before asserting live code. Commented-out
    // `eval(...)` references (the replace-don't-delete pattern) are expected.
    var stripLineComments = function (src) { return src.replace(/^\s*\/\/.*$/gm, ''); };

    it('main.js: cleared eval at the customRule site (#SCS1e)', function () {
        // The live eval references `gina.forms.rules.` — match that exact string
        // to distinguish cleared callsite from the three deferred (:2950, :2966,
        // :2978) eval sites that remain live.
        var live = stripLineComments(MAIN_SRC);
        assert.ok(
            !/eval\s*\(\s*['"]gina\.forms\.rules\./.test(live),
            'live code still contains eval("gina.forms.rules...")'
        );
    });

    it('main.js: carries the #SCS1e provenance tag', function () {
        assert.ok(/#SCS1e/.test(MAIN_SRC), '#SCS1e tag should be present in main.js');
    });

    it('main.js: the safe walker pattern is present', function () {
        // Assert both the grammar regex and the walker loop are in the file —
        // proves the inline primitive is there, not just a naked comment.
        assert.ok(
            /\[A-Za-z_\$\]\[\\w\$\]\*\(\\\.\[A-Za-z_\$\]\[\\w\$\]\*\)\*/.test(MAIN_SRC),
            'dot-path grammar regex should be present'
        );
        assert.ok(/customRule\.split\(['"]\.['"]\)/.test(MAIN_SRC), 'walker split(".") should be present');
    });

    it('main.js: cleared the previously-deferred root-path eval sites (#M20 / #SCS1f)', function () {
        // The three eval(root + ...) sites in makeObjectFromArgs were deferred
        // at #SCS1e (segments-array structural refactor needed) and shipped at
        // #M20 / #SCS1f. Lock the cleared state — any re-introduction must be
        // explicit and conscious. Full parity coverage in
        // test/lib/validator-scs1f.test.js.
        var live = stripLineComments(MAIN_SRC);
        assert.ok(!/eval\(root \+[^)]*\)/.test(live), 'M20/#SCS1f cleared the deferred root-path eval sites');
    });

    it('form-validator.js: cleared eval at compileError (#SCS1e)', function () {
        var live = stripLineComments(FORM_VAL_SRC);
        assert.ok(
            !/eval\s*\(\s*['"]data\./.test(live),
            'live code still contains eval("data....")'
        );
    });

    it('form-validator.js: cleared eval at is() regex-literal branch (#SCS1e)', function () {
        var live = stripLineComments(FORM_VAL_SRC);
        assert.ok(
            !/eval\s*\(\s*compiledCondition\s*\+\s*['"]\.test/.test(live),
            'live code still contains eval(compiledCondition + ".test(...)")'
        );
    });

    it('form-validator.js: cleared eval at is() binary-compare branch (#SCS1e)', function () {
        var live = stripLineComments(FORM_VAL_SRC);
        assert.ok(
            !/isValid\s*=\s*eval\s*\(\s*compiledCondition\s*\)/.test(live),
            'live code still contains isValid = eval(compiledCondition)'
        );
    });

    it('form-validator.js: carries the #SCS1e provenance tag', function () {
        assert.ok(/#SCS1e/.test(FORM_VAL_SRC), '#SCS1e tag should be present in form-validator.js');
    });

    it('form-validator.js: the safe primitives are present', function () {
        assert.ok(/_SCS_BINARY_RE/.test(FORM_VAL_SRC), 'binary-compare regex should be present');
        assert.ok(/_scsParseOperand/.test(FORM_VAL_SRC), 'parseOperand helper should be present');
        assert.ok(
            /_scsRegexMatch\s*=\s*compiledCondition\.match/.test(FORM_VAL_SRC),
            'regex-literal match should be present'
        );
        assert.ok(/_scsSegments/.test(FORM_VAL_SRC), 'bracket-walker segments should be present');
    });

    it('form-validator.js: the last deferred eval site is cleared by #M21d (zero live eval in the file)', function () {
        // The previously-deferred eval(condition) site was cleared by #M21b
        // (replaced with explicit throw documenting supported condition shapes).
        // The user-validator-function-body eval — the Pattern B site #M21c kept
        // under its trust model — was cleared by #M21d: the browser now compiles
        // the body as an inline <script> (compileUserValidator), so no live eval
        // is left anywhere in the engine.
        var live = stripLineComments(FORM_VAL_SRC);
        assert.ok(
            !/isValid\s*=\s*eval\s*\(\s*condition\s*\)/.test(live),
            'previously deferred eval(condition) should be cleared by #M21b'
        );
        assert.ok(
            !/(^|[^\w.$])eval\s*\(/.test(live) &&
            /compileUserValidator\s*\(\s*v\s*,\s*userValidator\s*\)/.test(live),
            'the user-validator-function-body eval should be cleared by #M21d (compileUserValidator in its place)'
        );
    });
});
