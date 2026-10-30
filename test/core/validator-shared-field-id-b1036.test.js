'use strict';
/**
 * The validator fix #B1036 — two forms that share a field id: a reset works on the form's own controls,
 * and the bind warns about the control it could not register — pinned in the source, executed on the
 * shipped bytes of `resetFields` and `warnSharedFieldId`, and pinned in both bundles. The behaviour is
 * driven end-to-end on the real bundle by `test/e2e/validator-shared-field-id-b1036.spec.js`.
 *
 *   §01 CONTROL — the premise, true on both sides of the fix: registration is keyed by the id alone
 *   §02 source pins (comment-stripped): only a refused registration warns, not a filtered tag
 *   §03 executed with recording stubs: another form's control holding the id is left alone and the
 *       form's own is restored; a target with no `elements` keeps what `getElementById` found; one warning
 *       per form and id, none when the id is unique, no throw on an id no selector can quote
 *   §04 dist fidelity (both bundles)
 *
 * Red-first: `GINA_B1036_MAIN_SRC=<file>` points §02–§03 at another copy of the validator source
 * (e.g. `git show <commit>:<path>` before the change), and `GINA_B1036_DIST_DIR=<dir>` points §04 at
 * another dist js directory. Every arm must fail there except those labelled CONTROL.
 *
 * Usage: node --test test/core/validator-shared-field-id-b1036.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B1036_MAIN_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR = process.env.GINA_B1036_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var SRC = fs.readFileSync(MAIN, 'utf8');

/**
 * Drops whole-line comments (`//`, `/*`, ` *`), so a pin never matches prose or a `was:` copy of
 * the code.
 *
 * @param {string} src
 * @returns {string}
 */
function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * Cuts a function expression out of `src`, from `decl` (which must occur once) to its closing brace.
 *
 * @param {string} src
 * @param {string} decl - the text that starts the declaration
 * @returns {string} the text from `function` to the closing brace
 */
function cutFunction(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, 'declaration not found: ' + decl);
    assert.equal(src.indexOf(decl, at + decl.length), -1, 'declaration not unique: ' + decl);
    var from = src.indexOf('function', at);
    var depth = 0, started = false;
    for (var i = from; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; }
        if (started && depth === 0) { return src.substring(from, i + 1); }
    }
    assert.fail('unbalanced braces after: ' + decl);
}

var ACTIVE = activeLines(SRC);

/** A stub text control. */
function textControl(id, form, value) {
    return { id: id, tagName: 'INPUT', type: 'text', value: value, form: form };
}

/**
 * Runs the extracted `resetFields` over a stub record.
 *
 * @param {object} target - the record's form
 * @param {object} found - what `document.getElementById` answers
 * @returns {Error|null} what it threw
 */
function runReset(target, found) {
    target.dataset = {};
    var record = { target: target, fieldsSet: { shared: { defaultValue: 'd' } }, rules: {} };
    var stubs = {
        document: { getElementById: function () { return found; } },
        gina: {},
        instance: { $forms: {} },
        console: { debug: function () {} },
        triggerEvent: function () {},
        getFormValidationInfos: function () { return { fields: {}, $fields: {} }; },
        handleErrorsDisplay: function () {},
        validate: function () {},
        updateSubmitTriggerState: function () {}
    };
    var names = Object.keys(stubs);
    var fn = new Function(names.join(','), 'return (' + cutFunction(ACTIVE, 'var resetFields = function(') + ');').apply(null, names.map(function (n) { return stubs[n]; }));
    try {
        fn(record);
    } catch (e) {
        return e;
    }
    return null;
}

/**
 * Builds the extracted `warnSharedFieldId` over a stub document and console.
 *
 * @param {function} queryAll - stands in for `document.querySelectorAll`
 * @returns {{warn: function, warnings: Array<string>, selectors: Array<string>}}
 */
function warner(queryAll) {
    var warnings = [], selectors = [];
    var at = ACTIVE.indexOf('var warnSharedFieldId = function(');
    assert.ok(at > -1, 'warnSharedFieldId is defined');
    var fn = new Function('document', 'console', 'warnedSharedFieldIds', 'return (' + cutFunction(ACTIVE, 'var warnSharedFieldId = function(') + ');')(
        { querySelectorAll: function (sel) { selectors.push(sel); return queryAll(sel); } },
        { warn: function (m) { warnings.push(m); } },
        {}
    );
    return { warn: fn, warnings: warnings, selectors: selectors };
}

/** A stub form record. */
function record(id) {
    return { target: { getAttribute: function () { return id; } } };
}

describe('validator-shared-field-id-b1036 §01 — the premise (CONTROL)', function () {

    it('01.1 CONTROL — registration is keyed by the id alone', function () {
        var fn = cutFunction(ACTIVE, 'var registerForLiveChecking = function(');
        assert.ok(fn.indexOf("typeof(gina.events['registered.' + $el.id]) != 'undefined'") > -1);
        assert.ok(fn.indexOf("gina.events['registered.' + $el.id] = $el.id;") > -1);
    });
});

describe('validator-shared-field-id-b1036 §02 — source pins', function () {

    var FN = cutFunction(ACTIVE, 'var registerForLiveChecking = function(');

    it('02.1 a filtered tag returns silently, a refused registration warns', function () {
        assert.match(FN, /if \( !isCustomEl && !\/\^\(input\|textarea\)\$\/i\.test\(\$el\.tagName\) \) \{\s*return\s*\}/);
        assert.match(FN, /if \( typeof\(gina\.events\['registered\.' \+ \$el\.id\]\) != 'undefined' \) \{\s*warnSharedFieldId\(\$form, \$el\);\s*return\s*\}/);
    });
});

describe('validator-shared-field-id-b1036 §03 — executed on the shipped bytes', function () {

    it('03.1 another form\'s control holds the id: the form\'s own is restored, the other left alone', function () {
        var mine = { elements: [] }, other = {};
        var own = textControl('shared', mine, 'typed');
        var neighbour = { id: 'x', tagName: 'INPUT', type: 'text', value: 'n', form: mine };
        mine.elements = [neighbour, own];
        var first = textControl('shared', other, 'in-first');
        assert.equal(runReset(mine, first), null);
        assert.equal(own.value, 'd', 'its own control is restored');
        assert.equal(first.value, 'in-first', 'the other form\'s is left alone');
        assert.equal(neighbour.value, 'n', 'and only the control with that id');
    });

    it('03.2 no control of the form holds the id any more: nothing is written', function () {
        var mine = { elements: [] }, other = {};
        var first = textControl('shared', other, 'in-first');
        assert.equal(runReset(mine, first), null);
        assert.equal(first.value, 'in-first');
    });

    it('03.3 CONTROL — a target with no `elements` keeps what getElementById found', function () {
        var target = {};
        var el = textControl('shared', null, 'typed');
        assert.equal(runReset(target, el), null);
        assert.equal(el.value, 'd');
    });

    it('03.4 one warning per form and id, naming both', function () {
        var w = warner(function () { return [1, 2]; });
        w.warn(record('second'), { id: 'ref' });
        w.warn(record('second'), { id: 'ref' });
        assert.equal(w.warnings.length, 1);
        assert.ok(w.warnings[0].indexOf('#second') > -1);
        assert.ok(w.warnings[0].indexOf('`ref`') > -1);
        w.warn(record('third'), { id: 'ref' });
        w.warn(record('second'), { id: 'other' });
        assert.equal(w.warnings.length, 3, 'another form, another id');
    });

    it('03.5 no warning when the id is unique in the page', function () {
        var w = warner(function () { return [1]; });
        w.warn(record('second'), { id: 'ref' });
        assert.deepEqual(w.warnings, []);
    });

    it('03.6 the id is quoted for the selector, and a selector that throws stays inside', function () {
        var w = warner(function () { return [1]; });
        w.warn(record('f'), { id: 'a"b\\c' });
        assert.equal(w.selectors[0], '[id="a\\"b\\\\c"]');
        var t = warner(function () { throw new Error('not a selector'); });
        assert.doesNotThrow(function () { t.warn(record('f'), { id: 'x' }); });
        assert.deepEqual(t.warnings, []);
    });
});

describe('validator-shared-field-id-b1036 §04 — dist fidelity', function () {

    var RAW = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var MIN = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8');

    it('04.1 both bundles carry the warning', function () {
        assert.ok(RAW.indexOf('is used more than once in this page') > -1);
        assert.ok(MIN.indexOf('is used more than once in this page') > -1);
    });

    it('04.2 gina.js carries the scoped lookup', function () {
        assert.ok(RAW.indexOf('if ( $element && $element.form != $form.target && $form.target.elements ) {') > -1);
    });

    it('04.3 gina.min.js carries the scoped lookup', function () {
        assert.match(MIN, /\.form\s*!=\s*\w+\.target\s*&&\s*\w+\.target\.elements/);
    });
});
