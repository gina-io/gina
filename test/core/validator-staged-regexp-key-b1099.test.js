'use strict';
/**
 * #B1099 — a top-level rule key written as a regular expression judges a staged file input whose
 * name it matches, and the input's value still never reaches the posted data.
 *
 * `bindForm` runs `checkForRuleAlias($form.rules, $input)` on every owned `<input>`, a staged file
 * input included, before any validation: when the input has no rule under its own name, the first
 * top-level key written `/pattern/flags` that matches the name (`[` and `]` read literally) is copied
 * under that name. The collectors then see a rule of the input's own and give it the names of the
 * files it holds (#B1058), so the rule judges them. The 0.7.9 notes said such a key does not match a
 * staged input; this file pins what the code does. It also drives #B1099's shape on that path: a
 * top-level RegExp key and a matching `_case_` condition that names the input, by a literal key or
 * by a RegExp key of its own; the input's value stays out of the data now that the terminal
 * exclusion walks the controls.
 *
 * Layers:
 *   01 source pins (comment-stripped): bindForm's input loop runs checkForRuleAlias first, on every
 *      owned input; both collectors give a staged input its files' names under a rule of its own (the
 *      condition the drive's collect() mirrors)
 *   02 the SHIPPED checkForRuleAlias, getStagedUploadValue and forEachField, lifted, driven with the
 *      REAL FormValidator engine; the data read is `d.toData()`, what the send path posts
 *      02.1 a top-level RegExp key alone, the input holding no file: judged and refused, no '' posted
 *      02.2 the same holding a file: judged, no error, no value posted
 *      02.3 CONTROL: a RegExp key that does not match the input's name: not collected, not judged
 *      02.4 SUBTRACT: 02.1's rules without the bind step: not collected, not judged, so 02.1's
 *           refusal comes from the alias
 *      02.5 #B1099 on the RegExp path: a top-level RegExp key and a matching `_case_` condition
 *           naming the input by a literal key: judged, no value posted
 *      02.6 the same with the condition naming the input by a RegExp key: judged, no value posted
 *      02.7 SUBTRACT: the exclusion walking the collected values again posts 02.5's and 02.6's value
 *   03 dist fidelity: gina.js's bindForm input loop runs the same alias step (the minified names make
 *      a structural pin on gina.min.js fragile; the code is unchanged by this fix)
 *
 * Run: node --test test/core/validator-staged-regexp-key-b1099.test.js
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
var DIST_RAW = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

var FE_DECL       = 'var forEachField = function($formOrElement, allFields, allRules, fields, $fields, rules, cb, i) {';
var FE_END_ANCHOR = 'addListener(gina, $formOrElement, evt';
var ALIAS_DECL    = 'var checkForRuleAlias = function(formRules, $el) {';
var STAGED_DECL   = 'var getStagedUploadValue = function($input) {';
var LOOP_NOW      = 'for (var stagedName in $fields) {';
var LOOP_WAS      = 'for (var stagedName in fields) {';

// bindForm's input loop: its first statement is the alias step, with no test of the input's type
var INPUT_LOOP_ALIAS = /for\s*\(\s*let\s+f\s*=\s*0\s*,\s*len\s*=\s*\$inputs\.length\s*;\s*f\s*<\s*len\s*;\s*\+\+f\s*\)\s*\{\s*checkForRuleAlias\s*\(\s*\$form\.rules\s*,\s*\$inputs\s*\[\s*f\s*\]\s*\)\s*;/g;
// the inputs bindForm walks: every owned <input>, whatever its type
var INPUTS_QUERY = /\$inputs\s*=\s*getOwnedElements\s*\(\s*\$target\s*,\s*'input'\s*\)/g;
// a collector's staged-input arm: the files' names under a rule of the input's own, nothing otherwise
var COLLECT_STAGED = /\.type\s*==\s*'file'\s*&&\s*\$(?:form|target)\s*\[\s*i\s*\]\s*\.getAttribute\(\s*'data-gina-form-upload-action'\s*\)\s*\)\s*\{\s*if\s*\(\s*rules\s*&&\s*typeof\s*\(\s*rules\s*\[\s*name\s*\]\s*\)\s*!=\s*'undefined'\s*\)\s*\{\s*fields\s*\[\s*name\s*\]\s*=\s*getStagedUploadValue\s*\(\s*\$(?:form|target)\s*\[\s*i\s*\]\s*\)\s*;\s*\}\s*\}\s*else\s*\{/g;

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
 * Counts the matches of a global regular expression.
 *
 * @inner
 * @param {string} hay - the text
 * @param {RegExp} re - a regular expression with the g flag
 * @returns {number} the count
 */
function countRe(hay, re) { return Array.from(hay.matchAll(re)).length; }

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
 * comment quoting the code cannot satisfy a pin.
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
 * The text of a function declared once in a source, from its declaration to its matching brace.
 *
 * @inner
 * @param {string} src - the source
 * @param {string} decl - the declaration, up to and including its opening brace
 * @returns {string} the function's text
 */
function liftByBraces(src, decl) {
    var s = src.indexOf(decl);
    assert.ok(s > -1, 'the declaration ' + decl);
    assert.equal(src.indexOf(decl, s + 1), -1, 'the declaration, once: ' + decl);
    var i = s + decl.length - 1, depth = 0;
    for (; i < src.length; ++i) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { break; } }
    }
    return src.substring(s, i + 1);
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
 * A staged file input holding files (the entries a staging left on it); its value is '' as the
 * browser keeps it for an edit form's saved file or after a failed staging.
 *
 * @inner
 * @param {string} name - its name and id
 * @param {Array<string>} names - the names of the files it holds
 * @returns {object} the control
 */
function staged(name, names) {
    var c = control('file', name, '', { 'data-gina-form-upload-action': '/stage' });
    c.customFiles = names.map(function (n) { return { name: n }; });
    c.pendingFiles = null;
    return c;
}

var src  = fs.readFileSync(MAIN, 'utf8');
var code = stripComments(src);
var fe   = sliceForEachField(src);

// the shipped alias step, its free `re` and `flags` given as parameters (they are assigned, never read first)
var checkForRuleAlias = new Function('re', 'flags', liftByBraces(src, ALIAS_DECL) + '\nreturn checkForRuleAlias;')(null, null);
var getStagedUploadValue = new Function(liftByBraces(src, STAGED_DECL) + '\nreturn getStagedUploadValue;')();

/**
 * bindForm's alias step: checkForRuleAlias on every control of the form.
 *
 * @inner
 * @param {object} rules - the form's rules (written in place, as bindForm writes its own copy)
 * @param {object} $fields - the controls, by name
 * @returns {object} the rules
 */
function bindAlias(rules, $fields) {
    for (var n in $fields) { checkForRuleAlias(rules, $fields[n]); }
    return rules;
}

/**
 * The collectors' two arms this file needs (pinned in 01.3): a staged file input gets the names of
 * its files under a rule of its own and nothing otherwise; any other control posts its value.
 *
 * @inner
 * @param {object} rules - the form's rules
 * @param {object} $fields - the controls, by name
 * @returns {object} the collected values
 */
function collect(rules, $fields) {
    var fields = {};
    for (var n in $fields) {
        var c = $fields[n];
        if (c.type == 'file' && c.getAttribute('data-gina-form-upload-action')) {
            if (rules && typeof(rules[n]) != 'undefined') { fields[n] = getStagedUploadValue(c); }
        } else {
            fields[n] = c.value;
        }
    }
    return fields;
}

/**
 * Binds and collects a form, then runs one pass of a forEachField text over it with the real engine
 * built from the collected values as validate() builds it, and a checkFieldAgainstRules that applies
 * each rule on the engine then deletes the field from the object it is handed (main.js,
 * `delete fields[field]`).
 *
 * @inner
 * @param {string} feText - the forEachField text
 * @param {object} $fields - the controls, by name
 * @param {object} rules0 - the rule set as declared
 * @param {object} [opts] - `{ bind: false }` skips the alias step
 * @returns {{rules: object, fields: object, data: object, errors: object, judged: Array<string>}} the
 *          bound rules, the collected values, the posted data, the errors and the rules applied
 */
function drive(feText, $fields, rules0, opts) {
    opts = opts || {};
    var run = new Function(FE_PARAMS.join(','), feText + '\nreturn forEachField(null, __allFields, __allRules, __fields, __$fields, __rules, undefined, 0);');
    var rules = JSON.parse(JSON.stringify(rules0));
    if (opts.bind !== false) { bindAlias(rules, $fields); }
    var collected = collect(rules, $fields);
    var fields = JSON.parse(JSON.stringify(collected));
    var d = new FormValidator(fields);
    var judged = [];
    var check = function (name, rulesArg, fieldsArg) {
        if (typeof rulesArg[name] == 'undefined') { return; }
        for (var rule in rulesArg[name]) {
            if (!d[name] || typeof d[name][rule] != 'function') { continue; }
            judged.push(name + '.' + rule);
            d[name][rule](rulesArg[name][rule]);
            delete fieldsArg[name];
        }
    };
    var noop = function () {};
    run(true, $fields, check, merge, 0, {}, d, function (x) { return x; }, false, {}, {}, noop, noop, noop, {}, 'validated.f', false, false, 0, null, 'f', null, null, null,
        JSON.parse(JSON.stringify(collected)), JSON.parse(JSON.stringify(rules)), fields, $fields, JSON.parse(JSON.stringify(rules)));
    return { rules: rules, fields: collected, data: d.toData(), errors: d.getErrors(), judged: judged };
}

/**
 * A form: a driver `kind` set to `pro`, a text `title` and a staged input `doc` holding `names`.
 *
 * @inner
 * @param {Array<string>} names - the files `doc` holds
 * @returns {object} the controls, by name
 */
function form(names) {
    return { kind: control('text', 'kind', 'pro'), title: control('text', 'title', 't'), doc: staged('doc', names) };
}

var KEY_ONLY      = { '/^doc/': { isRequired: true } };
var KEY_OTHER     = { '/^other/': { isRequired: true } };
var KEY_AND_CASE  = { kind: { isRequired: true }, '/^doc/': { isRequired: true },
    _case_kind: { conditions: [ { case: 'pro', rules: { doc: { isRequired: true } } } ] } };
var KEY_AND_RCASE = { kind: { isRequired: true }, '/^doc/': { isRequired: true },
    _case_kind: { conditions: [ { case: 'pro', rules: { '/^doc/': { isRequired: true } } } ] } };

describe('#B1099 - a top-level RegExp rule key judges a staged file input, whose value stays out of the data', function () {

    describe('01 - source pins (comment-stripped)', function () {
        it('01.1 - bindForm walks every owned <input>, whatever its type', function () {
            assert.equal(countRe(code, INPUTS_QUERY), 1, '$inputs = getOwnedElements($target, \'input\')');
        });

        it('01.2 - the input loop\'s first statement is the alias step', function () {
            assert.equal(countRe(code, INPUT_LOOP_ALIAS), 1, 'checkForRuleAlias($form.rules, $inputs[f]) opens the loop');
        });

        it('01.3 - both collectors give a staged input its files\' names under a rule of its own only', function () {
            assert.equal(countRe(code, COLLECT_STAGED), 2, 'the two staged-input arms the drive mirrors');
        });

        it('01.4 - forEachField\'s terminal exclusion walks the controls', function () {
            assert.equal(count(code, LOOP_NOW), 1, 'the exclusion walks $fields');
            assert.equal(count(code, LOOP_WAS), 0, 'no exclusion walks the collected values');
        });

        it('[instrument] the raw source carries what the stripped read counts', function () {
            assert.ok(countRe(src, INPUTS_QUERY) >= 1, 'the raw source holds the query');
            assert.ok(countRe(src, INPUT_LOOP_ALIAS) >= 1, 'the raw source holds the loop');
            // comments sit inside the raw arms, so the whole-arm pattern reads the stripped text only
            assert.ok(count(src, 'fields[name] = getStagedUploadValue(') >= 2, 'the raw source holds both arms\' assignment');
        });
    });

    describe('02 - the shipped alias step, collector value and forEachField, driven with the real engine', function () {
        it('02.1 - a top-level RegExp key alone, no file held: the input is judged and refused, no \'\' posted', function () {
            var res = drive(fe, form([]), KEY_ONLY);
            assert.deepEqual(res.rules.doc, { isRequired: true }, 'the alias step wrote the rule under the input\'s name');
            assert.equal(res.fields.doc, '', 'the collector gave the input its (empty) files\' names');
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.ok(res.errors.doc && res.errors.doc.isRequired, 'doc is refused');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.2 - the same holding a file: judged, no error, no value posted', function () {
            var res = drive(fe, form(['a.png']), KEY_ONLY);
            assert.equal(res.fields.doc, 'a.png', 'the collector gave the input its files\' names');
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.deepEqual(res.errors, {}, 'it holds a file');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.3 - CONTROL: a RegExp key that does not match the input\'s name: not collected, not judged', function () {
            var res = drive(fe, form([]), KEY_OTHER);
            assert.equal(typeof res.rules.doc, 'undefined', 'no rule under the input\'s name');
            assert.equal(Object.prototype.hasOwnProperty.call(res.fields, 'doc'), false, 'the input is not collected');
            assert.equal(res.judged.indexOf('doc.isRequired'), -1, 'doc is not judged');
            assert.deepEqual(res.errors, {}, 'nothing refused');
        });

        it('02.4 - SUBTRACT: 02.1\'s rules without the alias step: not collected, not judged', function () {
            var res = drive(fe, form([]), KEY_ONLY, { bind: false });
            assert.equal(typeof res.rules.doc, 'undefined', 'no rule under the input\'s name');
            assert.equal(Object.prototype.hasOwnProperty.call(res.fields, 'doc'), false, 'the input is not collected');
            assert.equal(res.judged.indexOf('doc.isRequired'), -1, 'doc is not judged');
            assert.deepEqual(res.errors, {}, 'nothing refused, so 02.1\'s refusal comes from the alias');
        });

        it('02.5 - a top-level RegExp key and a matching _case_ condition naming the input: judged, no value posted', function () {
            var res = drive(fe, form(['a.png']), KEY_AND_CASE);
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.deepEqual(res.errors, {}, 'it holds a file');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.6 - the same with the condition naming the input by a RegExp key: judged, no value posted', function () {
            var res = drive(fe, form(['a.png']), KEY_AND_RCASE);
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.deepEqual(res.errors, {}, 'it holds a file');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.7 - SUBTRACT: the exclusion walking the collected values again posts 02.5\'s and 02.6\'s value', function () {
            assert.equal(count(fe, LOOP_NOW), 1, 'the loop is in forEachField once');
            var was = fe.replace(LOOP_NOW, LOOP_WAS);
            assert.equal(drive(was, form(['a.png']), KEY_AND_CASE).data.doc, 'a.png', 'the drive sees 02.5\'s value');
            assert.equal(drive(was, form(['a.png']), KEY_AND_RCASE).data.doc, 'a.png', 'the drive sees 02.6\'s value');
        });
    });

    describe('03 - dist fidelity', function () {
        it('03.1 - the unminified bundle\'s bindForm runs the same alias step on every owned input', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assert.equal(countRe(raw, INPUTS_QUERY), 1, 'gina.js queries every owned <input>');
            assert.equal(countRe(raw, INPUT_LOOP_ALIAS), 1, 'gina.js opens the input loop with the alias step');
        });
    });
});
