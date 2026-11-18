'use strict';
/**
 * #B1095 — a `_case_` condition's rule on a staged file input judges the files the input holds.
 *
 * A staged file input never posts its own value; its rules judge the files it holds, the names the
 * collectors give it (getStagedUploadValue), and only under a rule of its own (#B1058). A staged input
 * that only a `_case_` condition names was therefore absent from the collected values, and:
 *   - with one `_case_` key, the scan loop wrote the condition's rule and judged nothing (a field it
 *     never collected is entered only for a radio or a checkbox, #B914): a required staged input
 *     refused nothing;
 *   - with two or more keys, a non-last driver's direct-case block entered the input's own value
 *     (`''` for an edit form's saved file, the browser's placeholder after a staging), so a held
 *     file was refused, or passed by accident.
 * Both sites now give it the names of its files (a helper declared inside forEachField, since the
 * suites that lift forEachField pass it only the names it uses), and the submit gate re-syncs on a
 * file change when the form's rules hold a `_case_` key. Its value never reaches the data (#B1099).
 *
 * Layers:
 *   01 source pins (comment-stripped): the helpers inside forEachField, the scan loop's entry, the
 *      direct-case block's two branches, the gate's `_case_` read
 *   02 the SHIPPED forEachField, lifted, driven with the REAL FormValidator engine
 *   03 the helper inside forEachField reads as getStagedUploadValue does, over a table
 *   04 the gate (extracted) re-validates a form whose rules hold a `_case_` key
 *   05 dist fidelity: gina.js carries the same lines; gina.min.js keeps one `[customFiles,
 *      pendingFiles]` read (getStagedUploadValue's, which the #B1058 suite locates) and carries the
 *      helper's read
 *
 * Run: node --test test/core/validator-staged-case-rule-b1095.test.js
 */

var describe = require('node:test').describe;
var it       = require('node:test').it;
var assert   = require('node:assert/strict');
var fs       = require('fs');
var path     = require('path');

var FW = require('../fw');

// Framework globals the real engine needs: Object.prototype.count() and the helpers, with a gina
// context so FormValidator builds headless (the recipe of validator-radio-required-collection).
process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0);
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', {}); }

var FormValidator = require(path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'form-validator.js'));

var MAIN     = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var FE_DECL       = 'var forEachField = function($formOrElement, allFields, allRules, fields, $fields, rules, cb, i) {';
var FE_END_ANCHOR = 'addListener(gina, $formOrElement, evt';

/**
 * Counts the occurrences of a needle.
 *
 * @inner
 * @param {string} hay - the text
 * @param {string} needle - what to count
 * @returns {number} the count
 */
function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The keywords after which an expression starts, so a `/` that follows one opens a regex literal.
 *
 * @constant
 * @type {Array<string>}
 */
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Whether a `/` met after the code read so far opens a regex literal.
 *
 * @inner
 * @param {string} out - the code read so far, comments dropped
 * @returns {boolean} true for a regex literal
 */
function regexMayStart(out) {
    var j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) { j--; }
    if (j < 0) { return true; }
    if ('(,=:[!&|?{};+-*%<>~^'.indexOf(out[j]) > -1) { return true; }
    if (!/[A-Za-z0-9_$]/.test(out[j])) { return false; }
    var k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) { k--; }
    return REGEX_KEYWORDS.indexOf(out.slice(k + 1, j + 1)) > -1;
}

/**
 * Drops `//` line comments and block comments outside string, template and regex literals, so a
 * `was:` line naming the old loop cannot satisfy a pin.
 *
 * @inner
 * @param {string} text - the source
 * @returns {string} the source without its comments
 */
function stripComments(text) {
    var out = '', i = 0, n = text.length, quote = null;
    while (i < n) {
        var c = text[i], d = text[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === quote) { quote = null; }
            i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { var e = text.indexOf('\n', i); if (e < 0) { e = n; } i = e; continue; }
        if (c === '/' && d === '*') { var f = text.indexOf('*/', i + 2); assert.ok(f > -1, 'unterminated block comment'); i = f + 2; continue; }
        if (c === '/' && regexMayStart(out)) {
            var inClass = false;
            out += c; i++;
            while (i < n) {
                var r = text[i];
                assert.ok(r !== '\n', 'unterminated regex literal');
                out += r;
                if (r === '\\') { out += text[i + 1]; i += 2; continue; }
                i++;
                if (r === '[') { inClass = true; }
                else if (r === ']') { inClass = false; }
                else if (r === '/' && !inClass) { break; }
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

/**
 * The text of `forEachField` in a source: from its declaration (found once) to the closing brace
 * before the listener registration that follows it.
 *
 * @inner
 * @param {string} src - the source
 * @returns {string} the function's text
 */
function sliceForEachField(src) {
    var s = src.indexOf(FE_DECL);
    assert.ok(s > -1, 'the forEachField declaration');
    assert.equal(src.indexOf(FE_DECL, s + 1), -1, 'the forEachField declaration, once');
    var e = src.indexOf(FE_END_ANCHOR, s);
    assert.ok(e > -1, 'the anchor after forEachField');
    return src.substring(s, src.lastIndexOf('}', e) + 1);
}

// forEachField's free names, passed in as parameters (the list the lifting suites use)
var FE_PARAMS = ['isGFFCtx', '$allFields', 'checkFieldAgainstRules', 'merge', 'subLevelRules', 'fieldErrorsAttributes', 'd', 'formatData', 'envIsDev',
    'gina', 'window', 'triggerEvent', 'addListener', 'removeListener', 'instance', 'evt', 'hasParsedAllRules', 'hasBeenValidated', 'asyncCount',
    'data', 'id', 're', 'flags', 'caseField', '__allFields', '__allRules', '__fields', '__$fields', '__rules'];

/**
 * Merges `b` then `a` into a new object, as the pass's merge() gives a condition's rule precedence.
 *
 * @inner
 * @param {object} a - the condition's rule
 * @param {object} b - the field's own rule
 * @returns {object} the merged rule
 */
function merge(a, b) { var o = {}, k; for (k in b) { o[k] = b[k]; } for (k in a) { o[k] = a[k]; } return o; }

/**
 * A control the pass reads: its type, value and attributes.
 *
 * @inner
 * @param {string} type - the control's type
 * @param {string} name - its name and id
 * @param {string} value - its value
 * @param {object} [attrs] - its attributes
 * @returns {object} the control
 */
function control(type, name, value, attrs) {
    attrs = attrs || {};
    return { type: type, tagName: 'INPUT', id: name, name: name, value: value, disabled: false,
        getAttribute: function (a) { return Object.prototype.hasOwnProperty.call(attrs, a) ? attrs[a] : (a === 'type' ? type : (a === 'id' ? name : null)); },
        setAttribute: function (a, v) { attrs[a] = v; } };
}

/**
 * A staged file input holding files (the entries a staging left on it), with its value as the browser
 * keeps it ('' for an edit form's saved file or after a failed staging).
 *
 * @inner
 * @param {string} name - its name and id
 * @param {Array<string>} names - the names of the files it holds
 * @param {string} [value] - its value ('' by default; the browser's placeholder after a staging)
 * @returns {object} the control
 */
function staged(name, names, value) {
    var c = control('file', name, value || '', { 'data-gina-form-upload-action': '/stage' });
    c.customFiles = names.map(function (n) { return { name: n }; });
    c.pendingFiles = null;
    return c;
}

/**
 * Runs one pass of a forEachField text over a scene, with the real engine built from the collected
 * values as validate() builds it, and a checkFieldAgainstRules that applies each rule on the engine
 * then deletes the field from the object it is handed (main.js, `delete fields[field]`).
 *
 * @inner
 * @param {string} feText - the forEachField text
 * @param {object} scene - `{ fields, $fields, rules }`
 * @returns {{data: object, errors: object, judged: Array<string>}} the posted data, the errors, the rules applied
 */
function drive(feText, scene) {
    var fe = new Function(FE_PARAMS.join(','), feText + '\nreturn forEachField(null, __allFields, __allRules, __fields, __$fields, __rules, undefined, 0);');
    var fields = JSON.parse(JSON.stringify(scene.fields));
    var d = new FormValidator(fields);
    var judged = [];
    var check = function (name, rulesArg, fieldsArg) {
        if (typeof rulesArg[name] == 'undefined') { return; }
        for (var rule in rulesArg[name]) {
            if (!d[name] || typeof d[name][rule] != 'function') { continue; }
            judged.push(name + '.' + rule + '=' + JSON.stringify(d[name].value));
            d[name][rule](rulesArg[name][rule]);
            delete fieldsArg[name];
        }
    };
    var noop = function () {};
    fe(true, scene.$fields, check, merge, 0, {}, d, function (x) { return x; }, false, {}, {}, noop, noop, noop, {}, 'validated.f', false, false, 0, null, 'f', null, null, null,
        JSON.parse(JSON.stringify(scene.fields)), JSON.parse(JSON.stringify(scene.rules)), fields, scene.$fields, JSON.parse(JSON.stringify(scene.rules)));
    return { data: d.toData(), errors: d.getErrors(), judged: judged };
}

var SEED_SCAN   = 'fields[_r] = stagedUploadValueOf($fields[_r]);';
var SEED_GUARD  = "typeof(fields[_r]) == 'undefined' && typeof(d[_r]) == 'undefined'";
var SEED_LIT    = 'fields[f] = ( isStagedUploadControl($fields[f]) ) ? stagedUploadValueOf($fields[f]) : $fields[f].value;';
var SEED_RE     = 'fields[localField] = ( isStagedUploadControl($fields[localField]) ) ? stagedUploadValueOf($fields[localField]) : $fields[localField].value;';
var HELPER_IS   = 'var isStagedUploadControl = function($control) {';
var HELPER_VAL  = 'var stagedUploadValueOf = function($control) {';
var STAGED_DECL = 'var getStagedUploadValue = function($input) {';
var GATE_DECL   = 'var resyncStagedUploadGate = function($input) {';
var MIN_STAGED_LISTS = /\[\s*([\w$]+)\s*\.\s*customFiles\s*,\s*\1\s*\.\s*pendingFiles\s*\]/g;
// the helper's read in gina.min.js: one list or the other by a test, in either order
var MIN_HELPER_READ  = /\?\s*([\w$]+)\s*\.\s*customFiles\s*:\s*\1\s*\.\s*pendingFiles|\?\s*([\w$]+)\s*\.\s*pendingFiles\s*:\s*\2\s*\.\s*customFiles/g;

/**
 * The text of a function in a comment-stripped source, from its declaration to its matching closing
 * brace (the functions read here hold no brace inside a string or a regex literal).
 *
 * @inner
 * @param {string} text - the source
 * @param {string} decl - the declaration line, up to its opening brace
 * @param {string} label - names the function in the messages
 * @returns {string} `function(...) { ... }`
 */
function functionText(text, decl, label) {
    var s = text.indexOf(decl);
    assert.ok(s > -1, label + ': found');
    assert.equal(text.indexOf(decl, s + 1), -1, label + ': found once');
    var open = s + decl.length - 1, depth = 0, k = open;
    for (; k < text.length; ++k) {
        if (text[k] === '{') { depth++; }
        else if (text[k] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, label + ': balanced braces');
    return text.substring(s + decl.indexOf('function'), k + 1);
}

/**
 * A form with a driver `kind` set to `pro`, a text `title`, a staged input `doc` and the rules given;
 * `doc` is never collected (no rule of its own).
 *
 * @inner
 * @param {Array<string>} names - the files `doc` holds
 * @param {object} rules - the rule set
 * @param {string} [value] - `doc`'s own value
 * @param {object} [extra] - more controls and values: `{ name: [control, value] }`
 * @returns {{fields: object, $fields: object, rules: object}} the scene
 */
function scene(names, rules, value, extra) {
    var fields = { kind: 'pro', title: 't' }, $fields = { kind: control('text', 'kind', 'pro'), title: control('text', 'title', 't'), doc: staged('doc', names, value) };
    for (var k in (extra || {})) { $fields[k] = extra[k][0]; fields[k] = extra[k][1]; }
    return { fields: fields, $fields: $fields, rules: rules };
}

var ONE_KEY = { kind: { isRequired: true }, _case_kind: { conditions: [ { case: 'pro', rules: { doc: { isRequired: true } } } ] } };
// doc named by the FIRST of two `_case_` keys, so its driver's direct-case block runs
var TWO_KEYS = { kind: { isRequired: true }, _case_kind: { conditions: [ { case: 'pro', rules: { doc: { isRequired: true } } } ] },
    _case_other: { conditions: [ { case: 'x', rules: { title: { isRequired: true } } } ] } };
var OTHER = { other: [control('text', 'other', 'x'), 'x'] };

/**
 * The values `doc` was judged on, from the engine's record of a pass.
 *
 * @inner
 * @param {Array<string>} judged - `<name>.<rule>=<value>` entries
 * @returns {Array<string>} the values judged for `doc`'s isRequired, as JSON
 */
function docValues(judged) {
    return judged.filter(function (j) { return j.indexOf('doc.isRequired=') === 0; }).map(function (j) { return j.slice('doc.isRequired='.length); });
}

var src  = fs.readFileSync(MAIN, 'utf8');
var code = stripComments(src);
var fe   = sliceForEachField(src);
var feCode = stripComments(fe);

describe('#B1095 - a `_case_` rule on a staged file input judges the files it holds', function () {

    describe('01 - source pins (comment-stripped)', function () {
        it('01.1 - forEachField declares both helpers inside its own text', function () {
            assert.equal(count(feCode, HELPER_IS), 1, 'isStagedUploadControl');
            assert.equal(count(feCode, HELPER_VAL), 1, 'stagedUploadValueOf');
            assert.equal(count(code, HELPER_VAL), 1, 'declared nowhere else');
        });

        it('01.2 - the scan loop enters a staged input a matching condition names, guarded on one line', function () {
            assert.equal(count(feCode, SEED_SCAN), 1, 'the entry');
            assert.equal(count(feCode, SEED_GUARD), 1, 'its guard, on one line');
        });

        it('01.3 - the direct-case block gives a staged input its files in both branches', function () {
            assert.equal(count(feCode, SEED_LIT), 1, 'the literal branch');
            assert.equal(count(feCode, SEED_RE), 1, 'the RegExp branch');
        });

        it('01.4 - the gate re-syncs when the form\'s rules hold a `_case_` key', function () {
            var gate = functionText(code, GATE_DECL, 'resyncStagedUploadGate');
            assert.ok(/\/\^_case_\/\.test\(/.test(gate), 'the gate reads the `_case_` keys');
        });

        it('[instrument] the raw source carries the lines the stripped reads count', function () {
            [SEED_SCAN, SEED_LIT, SEED_RE, HELPER_IS, HELPER_VAL].forEach(function (n) { assert.ok(count(src, n) >= 1, n); });
        });
    });

    describe('02 - the shipped forEachField, driven with the real engine', function () {
        it('02.1 - one key, the input holds a file: judged on its name, valid, nothing posted for it', function () {
            var res = drive(fe, scene(['a.png'], ONE_KEY));
            assert.deepEqual(docValues(res.judged), ['"a.png"']);
            assert.deepEqual(res.errors, {});
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.2 - one key, the input holds nothing: refused, nothing posted for it', function () {
            var res = drive(fe, scene([], ONE_KEY));
            assert.deepEqual(docValues(res.judged), ['""']);
            assert.ok(res.errors.doc && res.errors.doc.isRequired, 'doc is refused');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false);
        });

        it('02.3 - one key, the case does not match: not judged', function () {
            var s = scene(['a.png'], ONE_KEY); s.fields.kind = 'basic'; s.$fields.kind = control('text', 'kind', 'basic');
            var res = drive(fe, s);
            assert.deepEqual(docValues(res.judged), []);
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false);
        });

        it('02.4 - two keys, an edit form holding a saved file (value \'\'): judged on the file, valid', function () {
            var res = drive(fe, scene(['a.png'], TWO_KEYS, '', OTHER));
            assert.ok(docValues(res.judged).length > 0, 'doc is judged');
            docValues(res.judged).forEach(function (v) { assert.equal(v, '"a.png"', 'never on the input\'s own value'); });
            assert.deepEqual(res.errors, {});
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false);
        });

        it('02.5 - two keys, after a staging (the placeholder value): judged on the file, not the placeholder', function () {
            var res = drive(fe, scene(['a.png'], TWO_KEYS, 'C:\\fakepath\\a.png', OTHER));
            docValues(res.judged).forEach(function (v) { assert.equal(v, '"a.png"'); });
            assert.ok(docValues(res.judged).length > 0, 'doc is judged');
        });

        it('02.6 - two keys, the input holds nothing: refused', function () {
            var res = drive(fe, scene([], TWO_KEYS, '', OTHER));
            assert.ok(res.errors.doc && res.errors.doc.isRequired, 'doc is refused');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false);
        });

        it('02.7 - CONTROL: a text field that a matching condition names is judged on its value', function () {
            var s = { fields: { kind: 'pro', note: '' }, $fields: { kind: control('text', 'kind', 'pro'), note: control('text', 'note', '') },
                rules: { kind: { isRequired: true }, _case_kind: { conditions: [ { case: 'pro', rules: { note: { isRequired: true } } } ] } } };
            var res = drive(fe, s);
            assert.ok(res.errors.note && res.errors.note.isRequired, 'note is refused');
        });

        it('02.8 - CONTROL: a top-level rule, the input collected with its names (#B1058): judged on them', function () {
            var s = scene(['a.png'], { kind: { isRequired: true }, doc: { isRequired: true } }); s.fields.doc = 'a.png';
            var res = drive(fe, s);
            assert.deepEqual(docValues(res.judged), ['"a.png"']);
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false);
        });
    });

    describe('03 - the helper inside forEachField reads as getStagedUploadValue does', function () {
        var TABLE = [
            { label: 'entries only', input: { customFiles: [ { name: 'a.png' }, { name: 'b.pdf' } ], pendingFiles: null } },
            { label: 'a selection still staging only', input: { customFiles: null, pendingFiles: [ { name: 'c.png' } ] } },
            { label: 'both, entries first', input: { customFiles: [ { name: 'a.png' } ], pendingFiles: [ { name: 'c.png' } ] } },
            { label: 'entries without a name are skipped', input: { customFiles: [ { name: '' }, null, { name: 'a.png' } ], pendingFiles: [] } },
            { label: 'nothing held', input: { customFiles: [], pendingFiles: null } },
            { label: 'neither list', input: {} }
        ];
        it('03.1 - the same value for every input of the table', function () {
            var helper = new Function('return (' + functionText(feCode, HELPER_VAL, 'stagedUploadValueOf') + ');')();
            var shipped = new Function('return (' + functionText(code, STAGED_DECL, 'getStagedUploadValue') + ');')();
            TABLE.forEach(function (c) { assert.equal(helper(c.input), shipped(c.input), c.label); });
            assert.equal(shipped(TABLE[2].input), 'a.png, c.png', 'the table reads real values');
        });

        it('03.2 - the staged test: a file input naming its staging action, and nothing else', function () {
            var is = new Function('return (' + functionText(feCode, HELPER_IS, 'isStagedUploadControl') + ');')();
            assert.equal(is(staged('doc', [])), true, 'a staged input');
            assert.equal(is(control('file', 'plain', '')), false, 'a file input without an action');
            assert.equal(is(control('text', 't', '')), false, 'a text field');
            assert.equal(is(undefined), false, 'no control');
            assert.equal(is({ type: 'file' }), false, 'a control without getAttribute');
        });
    });

    describe('04 - the gate', function () {
        function runGate(rules) {
            var calls = [], record = { rules: rules };
            var gate = new Function('instance', 'revalidateSilently', 'return (' + functionText(code, GATE_DECL, 'resyncStagedUploadGate') + ');')(
                { $forms: { f1: record } }, function (r) { calls.push(r === record ? 'record' : 'another'); });
            gate({ name: 'doc', form: { getAttribute: function (n) { return n === 'id' ? 'f1' : null; } } });
            return calls;
        }
        it('04.1 - a form whose rules hold a `_case_` key is re-validated', function () {
            assert.deepEqual(runGate(ONE_KEY), ['record']);
        });
        it('04.2 - CONTROL: no rule for the input and no `_case_` key: not re-validated', function () {
            assert.deepEqual(runGate({ title: { isRequired: true } }), []);
        });
        it('04.3 - CONTROL: a rule of its own: re-validated, as before', function () {
            assert.deepEqual(runGate({ doc: { isRequired: true } }), ['record']);
        });
    });

    describe('05 - dist fidelity', function () {
        it('05.1 - the unminified bundle carries the same lines', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            [SEED_SCAN, SEED_GUARD, SEED_LIT, SEED_RE, HELPER_IS, HELPER_VAL].forEach(function (n) { assert.equal(count(raw, n), 1, n); });
        });

        it('05.2 - the minified bundle keeps one `[customFiles, pendingFiles]` read and carries the helper\'s', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal(Array.from(min.matchAll(MIN_STAGED_LISTS)).length, 1, 'getStagedUploadValue\'s read, once');
            assert.equal(Array.from(min.matchAll(MIN_HELPER_READ)).length, 1, 'the helper\'s read, once');
        });
    });
});
