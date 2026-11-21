'use strict';
/**
 * #B879 — a bind given no rule resolves the form's rule set the way the first bind does:
 * `data-gina-form-rule` first, then the form's id.
 *
 * The defect: `bindForm` looked a no-rule bind up by the form's id ONLY. The first bind of a form
 * carrying `data-gina-form-rule` is handed the rule by its caller (the boot scan, `initForm`,
 * `validateFormById`), but `reBind()` re-binds with no rule — and so do `.bind()` and
 * `getFormById()` on an unbound form. A form whose id names no rule set (`<form id="order-2"
 * data-gina-form-rule="order">`) was therefore re-bound with an EMPTY rule set: no field was
 * live-checked, the bind-time silent validation was skipped, and the submit trigger kept the
 * gated mark of the previous bind, so the first click on a valid form was refused. Until 0.7.4 the
 * previous bind's listeners stayed attached across a `reBind()` and could hide it; since #B585
 * detaches them, nothing re-evaluates the gate. The behaviour is driven end-to-end on the real
 * bundle by `test/e2e/validator-rebind-rule-b879.spec.js`; this file pins the resolution step:
 *
 *  - §01 the step's structure inside `bindForm`: it runs only when no rule was given, adopts the
 *    attribute only when it names a known rule set, and sits after the record is resolved and
 *    before the rule branch (which keeps its id lookup as the fallback);
 *  - §02 the step itself, extracted from the source and executed on stubs;
 *  - §03 the built bundles carry it (dist pins: RED before the rebuild, green after).
 *
 * Red-first: `GINA_B879_MAIN=<file>` points §01 and §02 at another copy of the validator source,
 * e.g. `git show HEAD:<path>` before the change — every §01/§02 arm must fail there except the
 * two labelled CONTROL, and the §02 arms must fail to extract.
 *
 * Usage: node --test test/core/validator-rebind-rule-b879.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
var MAIN     = process.env.GINA_B879_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

// The step, as it reads in the source once comments are stripped.
var STEP_HEAD = "if ( typeof(customRule) == 'undefined' && $target.getAttribute('data-gina-form-rule') ) {";
var STEP_RE   = /if \( typeof\(customRule\) == 'undefined' && \$target\.getAttribute\('data-gina-form-rule'\) \) \{\s*var attrRule = \$target\.getAttribute\('data-gina-form-rule'\)\.replace\(\/\\-\|\\\/\/g, '\.'\);\s*if \( typeof\(rules\[attrRule\]\) != 'undefined' \) \{\s*customRule = attrRule;\s*\}\s*\}/;

var SRC;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
});

/**
 * Strips block comments then whole-line comments, so pins do not trip on prose.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return commentStrip.lines(src);
}

/**
 * The head of `bindForm`: from its declaration (anchored at a line start, so the closing
 * `// EO bindForm()` comment cannot match) to the live-check comment that follows the rule branch.
 * Both anchors must occur exactly once.
 *
 * @param {string} src
 * @returns {string}
 */
function bindFormHead(src) {
    var decl = /^[ \t]*var bindForm = function\(\$target, customRule\) \{/mg;
    var m = decl.exec(src);
    assert.ok(m, 'the bindForm declaration must be present');
    assert.equal(decl.exec(src), null, 'the bindForm declaration must occur once');
    var end = '// Live check by default - data-gina-form-live-check-enabled';
    var endIdx = src.indexOf(end, m.index);
    assert.ok(endIdx > m.index, 'the live-check comment must follow the bindForm declaration');
    assert.equal(src.indexOf(end, endIdx + 1), -1, 'the live-check comment must occur once');
    return src.substring(m.index, endIdx);
}

/**
 * Extracts the resolution step — the `if` block starting with STEP_HEAD — by brace-walking from
 * its head. The block holds no brace inside a string or a regular expression, so the walk is
 * sound for it.
 *
 * @param {string} src
 * @returns {string} the block, `if` through its closing brace
 */
function extractStep(src) {
    var at = src.indexOf(STEP_HEAD);
    assert.ok(at > -1, 'the #B879 resolution step must be present');
    assert.equal(src.indexOf(STEP_HEAD, at + 1), -1, 'the #B879 resolution step must occur once');
    var depth = 0;
    for (var i = src.indexOf('{', at), len = src.length; i < len; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return src.substring(at, i + 1);
            }
        }
    }
    assert.fail('unbalanced braces walking the #B879 step');
}

/**
 * Compiles the extracted step into `function (customRule, $target, rules)` returning the rule the
 * rest of `bindForm` will use.
 *
 * @param {string} src
 * @returns {function}
 */
function compileStep(src) {
    return new Function('customRule', '$target', 'rules', extractStep(src) + '\nreturn customRule;');
}

/**
 * A stub form element: answers `getAttribute('data-gina-form-rule')` and counts the calls.
 *
 * @param {string|null} rule - the attribute value, or null when absent
 * @returns {object}
 */
function stubForm(rule) {
    var el = {
        reads: 0,
        getAttribute: function (k) {
            el.reads++;
            return (k === 'data-gina-form-rule') ? rule : null;
        }
    };
    return el;
}

/**
 * Occurrence count that is safe on minified single-line files.
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    return hay.split(needle).length - 1;
}

// ============================================================================
// §01 — the step's structure inside bindForm
// ============================================================================
describe('#B879 §01 — bindForm resolves a no-rule bind from data-gina-form-rule first', function () {

    it('01.1 - the step adopts the attribute only when no rule was given and it names a known rule set', function () {
        var head = stripComments(bindFormHead(SRC));
        assert.match(head, STEP_RE);
    });

    it('01.2 - the step runs after the record is resolved and before the rule branch', function () {
        var head = stripComments(bindFormHead(SRC));
        var resolved = head.indexOf('$target = $form.target;');
        var step     = head.indexOf(STEP_HEAD);
        var branch   = head.indexOf('withRules = true;');
        assert.ok(resolved > -1, 'the record resolution must be present');
        assert.ok(branch > -1, 'the rule branch must be present');
        assert.ok(step > resolved, 'the step must follow the record resolution');
        assert.ok(step < branch, 'the step must precede the rule branch');
    });

    it('01.3 - CONTROL: the rule branch keeps its id lookup as the fallback', function () {
        var head = stripComments(bindFormHead(SRC));
        assert.ok(head.indexOf("typeof(rules[_id.replace(/\\-|\\//g, '.')]) != 'undefined'") > -1, 'the id lookup');
        assert.ok(head.indexOf("rule = getRuleObjByName(_id.replace(/\\-|\\//g, '.'))") > -1, 'the id fallback');
    });

    it('01.4 - CONTROL: the first bind still hands the attribute rule over (boot scan and initForm)', function () {
        var code = stripComments(SRC);
        assert.ok(count(code, "$allForms[f].getAttribute('data-gina-form-rule')") >= 1, 'the boot scan reads the attribute');
        assert.ok(count(code, "$form.getAttribute('data-gina-form-rule')") >= 1, 'initForm reads the attribute');
    });
});

// ============================================================================
// §02 — the step, extracted and executed
// ============================================================================
describe('#B879 §02 — the resolution step, executed', function () {

    var RULES = { 'order': { ref: { isRequired: true } }, 'shop.order.form': { qty: { isNumber: true } } };

    it('02.1 - no rule given, the attribute names a known rule set: the step returns its dotted name', function () {
        var step = compileStep(SRC);
        assert.equal(step(undefined, stubForm('order'), RULES), 'order');
        assert.equal(step(undefined, stubForm('shop/order-form'), RULES), 'shop.order.form');
    });

    it('02.2 - no rule given, the attribute names no known rule set: nothing is adopted (the id lookup follows)', function () {
        var step = compileStep(SRC);
        assert.equal(step(undefined, stubForm('no-such-rule'), RULES), undefined);
    });

    it('02.3 - no rule given, no attribute: nothing is adopted', function () {
        var step = compileStep(SRC);
        var el = stubForm(null);
        assert.equal(step(undefined, el, RULES), undefined);
        assert.equal(el.reads, 1, 'the attribute is read once');
    });

    it('02.4 - a rule given by the caller wins: the attribute is never read', function () {
        var step = compileStep(SRC);
        var given = { ref: { isRequired: true } };
        var el1 = stubForm('order'), el2 = stubForm('order'), el3 = stubForm('order');
        assert.equal(step(given, el1, RULES), given);
        assert.equal(step('shop.order.form', el2, RULES), 'shop.order.form');
        assert.equal(step(null, el3, RULES), null);
        assert.equal(el1.reads + el2.reads + el3.reads, 0);
    });
});

// ============================================================================
// §03 — dist fidelity
// ============================================================================
describe('#B879 §03 — dist fidelity', function () {

    it('03.1 - gina.js carries the step', function () {
        var distJs = stripComments(fs.readFileSync(DIST, 'utf8'));
        assert.match(distJs, STEP_RE);
    });

    it('03.2 - gina.min.js carries the step: the attribute is read wherever the source reads it, plus twice in bindForm', function () {
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        // either quote: Closure keeps this literal single-quoted today (measured 2026-10-15: 6 = 6)
        var needle  = /\.getAttribute\(\s*['"]data-gina-form-rule['"]\s*\)/g;
        var inMin   = (distMin.match(needle) || []).length;
        var inSrc   = (stripComments(SRC).match(/\.getAttribute\(\s*'data-gina-form-rule'\s*\)/g) || []).length;
        assert.ok(inSrc >= 2, 'the source reads the attribute');
        assert.equal(inMin, inSrc, 'gina.min.js reads the attribute as often as the validator source');
        // instrument control: a literal that exists nowhere must read absent
        assert.equal(distMin.indexOf('zzz-b879-never-shipped'), -1);
    });
});
