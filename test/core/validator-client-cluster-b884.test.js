'use strict';
/**
 * The validator client fixes #B884, #B880 + #B802, #B881 and #B886, pinned in the source and
 * executed on stubs. The behaviour is driven end-to-end on the real bundle by
 * `test/e2e/validator-client-cluster-b884.spec.js`.
 *
 *  - §01 #B880 — `forEachField`'s error-attribute loop declares its variable: the validator no
 *    longer writes a GLOBAL `rule` (the loop ran in sloppy mode with an undeclared variable).
 *  - §02 #B802 — `reBindForm` tests its own `rules` argument (it tested that global `rule`), so
 *    `reBind(formId, rules)` applies the rule set it is handed whether or not an error was found.
 *  - §03 #B881 — `unbindForm` called as a handle method with no argument unbinds the handle's own
 *    form (it threw), and its non-element branch throws its own message (it referenced an
 *    undeclared `err`).
 *  - §04 #B884 — `isCaseConditionTarget` names the fields a `_case_` condition can make required,
 *    and `addLiveForInput` gives such a field its live listener even before it has a rule.
 *  - §05 #B886 — the live check's input-type allowlist includes `tel`, `url`, `search` and the
 *    date/time family.
 *  - §06 the built bundles carry the changes (dist pins: RED before the rebuild, green after).
 *
 * Red-first: `GINA_B884_MAIN=<file>` points §01–§05 at another copy of the validator source, e.g.
 * `git show HEAD:<path>` before the change — every arm must fail there except those labelled
 * CONTROL.
 *
 * Usage: node --test test/core/validator-client-cluster-b884.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
var MAIN     = process.env.GINA_B884_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC, CODE;

before(function () {
    SRC  = fs.readFileSync(MAIN, 'utf8');
    CODE = stripComments(SRC);
});

/**
 * Strips block comments then whole-line comments, so pins do not trip on prose (a call inside a
 * commented-out block must not count as live).
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return commentStrip.lines(src);
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

/**
 * Brace-walks from the first `{` at or after `from` to its matching `}`. Sound only for spans that
 * hold no brace inside a string or a regular expression literal — true for every span cut here.
 *
 * @param {string} src
 * @param {number} from
 * @returns {string} the span, `src[from]` through the closing brace
 */
function braceSpan(src, from) {
    var depth = 0;
    for (var i = src.indexOf('{', from), len = src.length; i < len; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.substring(from, i + 1);
        }
    }
    assert.fail('unbalanced braces walking from offset ' + from);
}

/**
 * A function declared as `var <name> = function(<params>) {`, cut from the comment-stripped code.
 * The declaration must occur exactly once.
 *
 * @param {string} code
 * @param {string} head - the declaration, e.g. `var reBindForm = function(formId, rules, cb) {`
 * @returns {string} `function(...) { ... }`
 */
function cutFunction(code, head) {
    var at = code.indexOf(head);
    assert.ok(at > -1, 'missing: ' + head);
    assert.equal(code.indexOf(head, at + 1), -1, 'must occur once: ' + head);
    var fnAt = code.indexOf('function', at);
    return braceSpan(code, fnAt);
}

/** A stub form element with an id. */
function stubForm(id) {
    return {
        tagName: 'FORM',
        id: id,
        getAttribute: function (k) { return (k === 'id') ? id : null; }
    };
}

// ============================================================================
// §01 — #B880: no global `rule`
// ============================================================================
describe('#B880 §01 — the error-attribute loop declares its variable', function () {

    var LOOP_HEAD = "var errors = d['getErrors']();";
    var LOOP_END  = 'if (isGFFCtx)';

    /** The loop over the errors, cut from the source: `for (var field in errors) { ... }`. */
    function loopBlock(code) {
        var at = code.indexOf(LOOP_HEAD);
        assert.ok(at > -1, 'the getErrors() read must be present');
        assert.equal(code.indexOf(LOOP_HEAD, at + 1), -1, 'the getErrors() read must occur once');
        var forAt = code.indexOf('for (var field in errors)', at);
        assert.ok(forAt > at, 'the loop over the errors must follow the read');
        return braceSpan(code, forAt);
    }

    var hadRule;
    before(function () { hadRule = Object.prototype.hasOwnProperty.call(globalThis, 'rule'); });
    after(function () { if (!hadRule) { delete globalThis.rule; } });

    it('01.1 - no undeclared `for (rule in …)` remains in the source', function () {
        assert.equal((CODE.match(/for\s*\(\s*rule\s+in\b/g) || []).length, 0);
    });

    it('01.2 - the loop runs in sloppy mode on stubs and writes no global `rule`', function () {
        var block = loopBlock(CODE);
        // the loop body only touches these names; the setAttribute branch is gated on isGFFCtx
        var run = new Function('errors', 'fieldErrorsAttributes', 'isGFFCtx', '$fields', block + '\nreturn fieldErrorsAttributes;');
        if (!hadRule) { delete globalThis.rule; }
        var attrs = run({ name: { isRequired: 'required', isString: 'too short' } }, {}, false, {});
        assert.equal(attrs.name, 'isRequired isString ', 'the loop still collects the error names');
        assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'rule'), hadRule, 'no global `rule` was created');
    });
});

// ============================================================================
// §02 — #B802: reBind() applies the rules it is handed
// ============================================================================
describe('#B802 §02 — reBindForm tests its own `rules` argument', function () {

    var HEAD = 'var reBindForm = function(formId, rules, cb) {';

    /** reBindForm closed over stubs; returns { fn, calls }. */
    function build(code) {
        var calls = { bind: [], unbind: 0, reset: 0 };
        var form  = stubForm('f1');
        var instance = { $forms: { f1: { target: form } } };
        var factory = new Function('instance', 'resetErrorsDisplay', 'unbindForm', 'bindForm', 'return ' + cutFunction(code, HEAD) + ';');
        var fn = factory(
            instance,
            function () { calls.reset++; },
            function () { calls.unbind++; },
            function () { calls.bind.push(Array.prototype.slice.call(arguments)); }
        );
        return { fn: fn, calls: calls, form: form };
    }

    var hadRule, saved;
    before(function () { hadRule = Object.prototype.hasOwnProperty.call(globalThis, 'rule'); saved = globalThis.rule; });
    after(function () { if (hadRule) { globalThis.rule = saved; } else { delete globalThis.rule; } });

    it('02.1 - the test reads `rules`, never a bare `rule`', function () {
        var body = cutFunction(CODE, HEAD);
        assert.ok(body.indexOf("if ( typeof(rules) != 'undefined' ) {") > -1, 'the rules test');
        assert.equal((body.match(/typeof\(rule\)/g) || []).length, 0, 'no typeof(rule)');
    });

    it('02.2 - rules handed in are applied when no global `rule` exists (the state before any error)', function () {
        delete globalThis.rule;
        var b = build(CODE);
        b.fn.call({ target: b.form }, undefined, 'otherform');
        assert.equal(b.calls.bind.length, 1);
        assert.deepEqual(b.calls.bind[0].slice(1), ['otherform'], 'bindForm got the rules');
    });

    it('02.3 - no rules handed in: a no-rule bind, even when a global `rule` exists', function () {
        globalThis.rule = 'isRequired';
        var b = build(CODE);
        b.fn.call({ target: b.form });
        assert.equal(b.calls.bind.length, 1);
        assert.equal(b.calls.bind[0].length, 1, 'bindForm got the form only');
        delete globalThis.rule;
    });

    it('02.4 - CONTROL: the form is unbound and its errors reset before the bind', function () {
        delete globalThis.rule;
        var b = build(CODE);
        b.fn.call({ target: b.form }, undefined, 'otherform');
        assert.equal(b.calls.unbind, 1);
        assert.equal(b.calls.reset, 1);
    });
});

// ============================================================================
// §03 — #B881: unbind() with no argument
// ============================================================================
describe('#B881 §03 — unbindForm called with no argument unbinds the handle\'s form', function () {

    var HEAD = 'var unbindForm = function($target) {';
    var STOP = 'if ( typeof($form) != \'undefined\' && !$form.binded) {';

    /**
     * The head of unbindForm — its argument resolution, up to the not-binded early return —
     * compiled as `function($target) -> { form, id }` over a stub instance.
     */
    function buildHead(code, instance) {
        var fn = cutFunction(code, HEAD);
        var stop = fn.indexOf(STOP);
        assert.ok(stop > -1, 'the not-binded early return must be present');
        var head = fn.substring(fn.indexOf('{') + 1, stop);
        var factory = new Function('instance', 'return function($target) {' + head + '\nreturn { form: $form, id: _id }; };');
        return factory(instance);
    }

    it('03.1 - called as a handle method with no argument, it resolves the handle\'s own form', function () {
        var form = stubForm('f1');
        var record = { target: form, binded: true };
        var resolve = buildHead(CODE, { $forms: { f1: record } });
        var r = resolve.call(record);
        assert.equal(r.id, 'f1');
        assert.equal(r.form, record);
    });

    it('03.2 - a non-element argument throws its own message, not a ReferenceError', function () {
        var resolve = buildHead(CODE, { $forms: {} });
        assert.throws(function () { resolve.call(undefined, {}); }, function (err) {
            assert.match(err.message, /must be a DOM element/);
            assert.doesNotMatch(err.message, /err is not defined/);
            return true;
        });
    });

    it('03.3 - CONTROL: called with the form element, it resolves that form', function () {
        var form = stubForm('f1');
        var record = { target: form, binded: true };
        var resolve = buildHead(CODE, { $forms: { f1: record } });
        assert.equal(resolve.call(undefined, form).form, record);
    });
});

// ============================================================================
// §04 — #B884: a `_case_` target gets its live listener
// ============================================================================
describe('#B884 §04 — a field a `_case_` condition can make required is live-checked', function () {

    var HEAD = 'var isCaseConditionTarget = function(rules, field) {';

    function helper(code) {
        return new Function('return ' + cutFunction(code, HEAD) + ';')();
    }

    var RULES = {
        ref: { isRequired: true },
        _case_kind: { conditions: [
            { case: 'a', rules: { other: { isRequired: false } } },
            { case: 'b', rules: { extra: { isRequired: true }, '/^re[g]ex$/': { isRequired: true } } }
        ] }
    };

    it('04.1 - true for a field named in a condition\'s rules, in any condition', function () {
        var is = helper(CODE);
        assert.equal(is(RULES, 'extra'), true);
        assert.equal(is(RULES, 'other'), true);
    });

    it('04.2 - false for a field no condition names, for the driver itself, and for a RegExp key (the live merge skips those)', function () {
        var is = helper(CODE);
        assert.equal(is(RULES, 'ref'), false);
        assert.equal(is(RULES, 'kind'), false);
        assert.equal(is(RULES, 'regex'), false);
    });

    it('04.3 - false without any `_case_` block, and on malformed blocks', function () {
        var is = helper(CODE);
        assert.equal(is({ extra: { isRequired: true } }, 'extra'), false);
        assert.equal(is({ _case_kind: null }, 'extra'), false);
        assert.equal(is({ _case_kind: { conditions: 'b' } }, 'extra'), false);
        assert.equal(is({ _case_kind: { conditions: [null, { case: 'b' }, { case: 'c', rules: 'x' }] } }, 'extra'), false);
        assert.equal(is(null, 'extra'), false);
        assert.equal(is(RULES, ''), false);
        assert.equal(is(RULES, undefined), false);
    });

    it('04.4 - addLiveForInput consults it at both gates: the no-rule return and the listener branch', function () {
        var fn = cutFunction(CODE, 'var addLiveForInput = function($form, $el, liveCheckTimer, isOtherTagAllowed) {');
        assert.ok(fn.indexOf('var isCaseTarget = ( !localRule ) ? isCaseConditionTarget(rules, field) : false;') > -1, 'computed once');
        assert.ok(fn.indexOf("if ( typeof(rules[field]) == 'undefined' && !isCaseTarget )") > -1, 'the no-rule return spares a case target');
        assert.ok(fn.indexOf('if ( $form.target.dataset.ginaFormLiveCheckEnabled && (localRule || isCaseTarget) ) {') > -1, 'the listener branch admits a case target');
    });
});

// ============================================================================
// §05 — #B886: the input-type allowlist
// ============================================================================
describe('#B886 §05 — the live check admits tel, url, search and the date/time family', function () {

    /** The allowlist RegExp, read out of addLiveForInput. */
    function allowlist(code) {
        var fn = cutFunction(code, 'var addLiveForInput = function($form, $el, liveCheckTimer, isOtherTagAllowed) {');
        var m = fn.match(/\/\^\(([a-z|\-]+)\)\$\/i\.test\(\$el\.type\)/);
        assert.ok(m, 'the allowlist test must be present');
        return new RegExp('^(' + m[1] + ')$', 'i');
    }

    it('05.1 - tel, url, search, time, datetime-local, month and week are admitted', function () {
        var re = allowlist(CODE);
        ['tel', 'url', 'search', 'time', 'datetime-local', 'month', 'week'].forEach(function (t) {
            assert.equal(re.test(t), true, t);
        });
    });

    it('05.2 - CONTROL: the types admitted before are still admitted', function () {
        var re = allowlist(CODE);
        ['radio', 'checkbox', 'text', 'hidden', 'password', 'number', 'date', 'email'].forEach(function (t) {
            assert.equal(re.test(t), true, t);
        });
    });

    it('05.3 - CONTROL: range, color, file and the button types stay out', function () {
        var re = allowlist(CODE);
        ['range', 'color', 'file', 'submit', 'button', 'reset', 'image'].forEach(function (t) {
            assert.equal(re.test(t), false, t);
        });
    });
});

// ============================================================================
// §06 — dist fidelity
// ============================================================================
describe('validator client fixes §06 — dist fidelity', function () {

    var ALLOW = '/^(radio|checkbox|text|hidden|password|number|date|email|tel|url|search|time|datetime-local|month|week)$/i';

    it('06.1 - gina.js carries the four changes', function () {
        var dist = stripComments(fs.readFileSync(DIST, 'utf8'));
        assert.equal((dist.match(/for\s*\(\s*rule\s+in\b/g) || []).length, 0, 'no undeclared loop');
        assert.ok(dist.indexOf('for (let rule in errors[field])') > -1, '#B880 loop');
        assert.ok(dist.indexOf('var isCaseConditionTarget = function(rules, field) {') > -1, '#B884 helper');
        assert.ok(dist.indexOf(ALLOW) > -1, '#B886 allowlist');
        var reBind = cutFunction(dist, 'var reBindForm = function(formId, rules, cb) {');
        assert.equal((reBind.match(/typeof\(rule\)/g) || []).length, 0, '#B802 test');
    });

    it('06.2 - gina.min.js carries the allowlist and no undeclared `rule` loop', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        assert.equal(count(min, ALLOW), 1, 'the allowlist literal');
        assert.equal((min.match(/for\s*\(\s*rule\s+in\b/g) || []).length, 0, 'no undeclared loop');
        // instrument control: a literal that exists nowhere must read absent
        assert.equal(min.indexOf('zzz-b884-never-shipped'), -1);
    });
});
