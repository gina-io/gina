'use strict';
/**
 * #B1099 — a staged file input's value never reaches the posted data, whichever site of the pass
 * judged it.
 *
 * A staged file input never posts its own value: its files travel in the hidden fields the staging
 * wrote, and `forEachField`'s terminal block leaves the input's value out of the data once every rule
 * of the pass has run (#B1058). That block walked `fields`, the collected values. The scan loop's check
 * of a field that a matching `_case_` condition names (`checkFieldAgainstRules`) deletes the field from
 * the object it is handed once its rules are applied, and the scan loop hands it `fields`. So a staged
 * input that has a top-level rule AND is named by a matching `_case_` condition had left `fields` when
 * the block ran: its value (its files' names, or '' when it holds none) was posted beside its hidden
 * fields, where it can replace the files' array (a page that renders saved-file fields before the
 * input). The block walks the controls now (`$fields`).
 *
 * Layers:
 *   01 source pin (comment-stripped): the exclusion walks the controls, once
 *   02 the SHIPPED forEachField, lifted, driven with the REAL FormValidator engine; the data read is
 *      `d.toData()`, what the send path posts (`formatData( d['toData']() )`)
 *      02.1 a staged input with a top-level rule and a matching `_case_` rule, holding a file: no value
 *      02.2 the same, holding no file: no '' either
 *      02.3 CONTROL: a top-level rule only (the case #B1058 tested): no value
 *      02.4 CONTROL: a text field that a matching `_case_` rule names keeps its value in the data
 *      02.5 SUBTRACT: the same block walking `fields` again posts 02.1's value, so the drive can see it
 *   03 dist fidelity: gina.js carries the same block; gina.min.js's exclusion iterates the controls it
 *      guards on
 *
 * Run: node --test test/core/validator-staged-case-exclusion-b1099.test.js
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
var LOOP_NOW      = 'for (var stagedName in $fields) {';
var LOOP_WAS      = 'for (var stagedName in fields) {';

// the minified exclusion: `if(<controls>)for(<k> in <iterated>)<controls>[<k>]&&<controls>[<k>].type=="file"&&…`
var MIN_EXCLUSION = /if\s*\(\s*([\w$]+)\s*\)\s*for\s*\(\s*(?:var\s+)?([\w$]+)\s+in\s+([\w$]+)\s*\)\s*\1\s*\[\s*\2\s*\]\s*&&\s*\1\s*\[\s*\2\s*\]\s*\.\s*type\s*==\s*(['"])file\4\s*&&\s*typeof\s+\1\s*\[\s*\2\s*\]\s*\.\s*getAttribute\s*==\s*(['"])function\5\s*&&\s*\1\s*\[\s*\2\s*\]\s*\.\s*getAttribute\s*\(\s*(['"])data-gina-form-upload-action\6\s*\)/g;

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
 * @returns {object} the control
 */
function staged(name, names) {
    var c = control('file', name, '', { 'data-gina-form-upload-action': '/stage' });
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
            judged.push(name + '.' + rule);
            d[name][rule](rulesArg[name][rule]);
            delete fieldsArg[name];
        }
    };
    var noop = function () {};
    fe(true, scene.$fields, check, merge, 0, {}, d, function (x) { return x; }, false, {}, {}, noop, noop, noop, {}, 'validated.f', false, false, 0, null, 'f', null, null, null,
        JSON.parse(JSON.stringify(scene.fields)), JSON.parse(JSON.stringify(scene.rules)), fields, scene.$fields, JSON.parse(JSON.stringify(scene.rules)));
    return { data: d.toData(), errors: d.getErrors(), judged: judged };
}

/**
 * A form: a driver `kind` set to `pro`, a text `title`, a staged input `doc` holding `names`, and the
 * rules given.
 *
 * @inner
 * @param {Array<string>} names - the files `doc` holds
 * @param {object} rules - the rule set
 * @param {boolean} collected - whether the collector gave `doc` its names (it does under a top-level rule)
 * @returns {{fields: object, $fields: object, rules: object}} the scene
 */
function stagedScene(names, rules, collected) {
    var fields = { kind: 'pro', title: 't' };
    if (collected) { fields.doc = names.join(', '); }
    return { fields: fields, $fields: { kind: control('text', 'kind', 'pro'), title: control('text', 'title', 't'), doc: staged('doc', names) }, rules: rules };
}

var CASE_ON_DOC = { _case_kind: { conditions: [ { case: 'pro', rules: { doc: { isRequired: true } } } ] } };
var TOP_AND_CASE = Object.assign({ kind: { isRequired: true }, doc: { isRequired: true } }, CASE_ON_DOC);

var src  = fs.readFileSync(MAIN, 'utf8');
var code = stripComments(src);
var fe   = sliceForEachField(src);

describe('#B1099 - a staged file input\'s value never reaches the posted data', function () {

    describe('01 - source pin (comment-stripped)', function () {
        it('01.1 - forEachField\'s terminal exclusion walks the controls, once', function () {
            assert.equal(count(code, LOOP_NOW), 1, 'the exclusion walks $fields');
            assert.equal(count(code, LOOP_WAS), 0, 'no exclusion walks the collected values');
        });

        it('[instrument] the raw source carries the loop the stripped read counts', function () {
            assert.ok(count(src, LOOP_NOW) >= 1, 'the raw source holds the loop');
        });
    });

    describe('02 - the shipped forEachField, driven with the real engine', function () {
        it('02.1 - a top-level rule and a matching _case_ rule on a staged input holding a file: its value is not posted', function () {
            var res = drive(fe, stagedScene(['a.png'], TOP_AND_CASE, true));
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.deepEqual(res.errors, {}, 'it holds a file');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.2 - the same holding no file: refused, and no \'\' posted for it', function () {
            var res = drive(fe, stagedScene([], TOP_AND_CASE, true));
            assert.ok(res.errors.doc && res.errors.doc.isRequired, 'doc is refused');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.3 - CONTROL: a top-level rule only, the case #B1058 tested: no value posted', function () {
            var res = drive(fe, stagedScene(['a.png'], { kind: { isRequired: true }, doc: { isRequired: true } }, true));
            assert.ok(res.judged.indexOf('doc.isRequired') > -1, 'doc is judged');
            assert.equal(Object.prototype.hasOwnProperty.call(res.data, 'doc'), false, 'no doc in ' + JSON.stringify(res.data));
        });

        it('02.4 - CONTROL: a text field that a matching _case_ rule names keeps its value in the data', function () {
            var scene = {
                fields: { kind: 'pro', title: 't', note: 'n' },
                $fields: { kind: control('text', 'kind', 'pro'), title: control('text', 'title', 't'), note: control('text', 'note', 'n') },
                rules: { kind: { isRequired: true }, _case_kind: { conditions: [ { case: 'pro', rules: { note: { isRequired: true } } } ] } }
            };
            var res = drive(fe, scene);
            assert.ok(res.judged.indexOf('note.isRequired') > -1, 'note is judged');
            assert.equal(res.data.note, 'n', 'the text field is posted');
        });

        it('02.5 - SUBTRACT: the block walking the collected values again posts 02.1\'s value', function () {
            assert.equal(count(fe, LOOP_NOW), 1, 'the loop is in forEachField once');
            var res = drive(fe.replace(LOOP_NOW, LOOP_WAS), stagedScene(['a.png'], TOP_AND_CASE, true));
            assert.equal(res.data.doc, 'a.png', 'the drive sees the value the old block let through');
        });
    });

    describe('03 - dist fidelity', function () {
        it('03.1 - the unminified bundle carries the same loop, once', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assert.equal(count(raw, LOOP_NOW), 1, 'gina.js walks $fields');
            assert.equal(count(raw, LOOP_WAS), 0, 'gina.js does not walk the collected values');
        });

        it('03.2 - the minified bundle\'s exclusion iterates the controls it guards on', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var found = Array.from(min.matchAll(MIN_EXCLUSION));
            assert.equal(found.length, 1, 'one exclusion in gina.min.js');
            assert.equal(found[0][3], found[0][1], 'the loop iterates `' + found[0][3] + '`, the controls are `' + found[0][1] + '`');
        });
    });
});
