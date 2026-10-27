'use strict';
/**
 * FormValidator - a staged selection takes the file input over when its staging succeeds (#B960, #B961)
 *
 * The file input's `change` listener used to write the input's entries (`customFiles`, the files its
 * reset and delete links act on), keep the stored entries the selection replaced (`_replacedStoredFiles`,
 * #B150), and build the form's hidden fields, all before the staging answered, while `onUpload`
 * emptied the preview container on every settle. So a FAILED staging left the page and the form out of
 * step: the previews of the files the input still held were gone, a stored file's delete link sent
 * nothing, a staged file's reset link was gone while its fields were still posted, and the fields the
 * failed selection had created were posted empty (#B960). While a staging was on the wire, a delete of
 * the stored file sent nothing, and a reset of the previous file took the new file's fields out of the
 * form before the answer filled them, so the save posted no file (#B961). Since the fix the listener
 * keeps the selection as `pendingFiles`; the staging success empties the container, removes the
 * replaced entries' delete links, takes the selection over and builds the fields; a failure drops the
 * pending selection and nothing else. The selection that creates the virtual upload form still binds
 * the reset triggers the page already holds.
 *
 * Strategy:
 *  - 01 source pins on the shipped `main.js`, comment-stripped: in `onUpload` the failure drop comes
 *    before the error branch, the container is emptied inside the success branch only, and the success
 *    records the answer, reads the replaced entries, takes the selection over, then builds the fields
 *    before the per-file loop fills them; the change listener builds no field and binds the reset
 *    triggers on the selection that creates the virtual form.
 *  - 02 dist fidelity: the unminified bundle carries the same sites in the same order; the minified
 *    bundle carries the pending selection's write and its take-over.
 *  The browser path end to end is test/e2e/validator-upload-failed-staging-b960.spec.js.
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B960_VALIDATOR_SRC=<copy of main.js>, B960_PLUGIN_DIST=<dir holding js/>.
 *
 * Usage: node --test test/core/validator-upload-commit-at-success-b960.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

var MAIN     = process.env.B960_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B960_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var ON_UPLOAD  = 'var onUpload = function(gina, $target, status, id, data) {';
var DROP       = "if ( status != 'success' && $uploadTriger ) {";
var DROP_LINE  = '$uploadTriger.pendingFiles = null;';
var ERROR_HEAD = "if ($error && status != 'success') {";
var NO_SLOT    = "} else if ( status != 'success' ) {";
var EMPTY      = "$previewContainer.innerHTML = '';";
var STAGED     = '$uploadTriger.stagedFiles = files;';
var REPLACED   = 'var replacedStoredFiles = ( $uploadTriger.customFiles || [] ).filter(function (entry) { return entry && entry.deleteLinkId; });';
var TAKEOVER   = '$uploadTriger.customFiles = $uploadTriger.pendingFiles || [];';
var BUILD      = 'uploadProperties.uploadFields = buildUploadHiddenFields($uploadTriger, getUploadFieldPrefix($uploadTriger), files.length, uploadProperties.mandatoryFields, false);';
var FILE_LOOP  = 'for (var f = 0, fLen = files.length; f<fLen; ++f) {';
var FILL       = 'fieldsObjectList = uploadProperties.uploadFields[f];';
var PENDING    = '$el.pendingFiles = Array.from(files);';
var BIND_RESET = "bindUploadResetOrDeleteTrigger('reset', $el, _r);";

// the minified listener's write, and the success's take-over, as Closure emits them
var MIN_PENDING  = '.pendingFiles=Array.from(';
var MIN_TAKEOVER = '.pendingFiles||[]';

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The keywords after which an expression starts, so a `/` that follows one opens a regex literal.
 *
 * @constant
 * @type {Array<string>}
 */
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Whether a `/` met after the code read so far opens a regex literal: the code ends with nothing,
 * an operator, a punctuator, or a keyword after which an expression starts. Anything else makes
 * the `/` a division.
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
 * Drops `//` line comments and `/* *\/` block comments outside string, template and regex
 * literals, so a `was:` line or a JSDoc naming a pinned expression cannot satisfy a pin. A regex
 * literal is copied as it is: read as code, the `\/` inside one opened a line comment, and the
 * quote inside `/"/g` opened a string that kept every comment up to the next quote character.
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
 * The text of `onUpload` in a source, from its head to the next top-level `var` declaration.
 *
 * @inner
 * @param {string} code - the comment-stripped source
 * @param {string} label - names the text in the messages
 * @returns {string} the function's text
 */
function onUploadText(code, label) {
    assert.equal(count(code, ON_UPLOAD), 1, label + ': the onUpload head');
    var at  = code.indexOf(ON_UPLOAD);
    var end = code.indexOf('\n    var ', at + ON_UPLOAD.length);
    assert.ok(end > at, label + ': the end of onUpload');
    return code.slice(at, end);
}

/**
 * Asserts the order of the settle in `onUpload`: the failure drop before the error branch, the
 * container emptied inside the success branch, then the answer recorded, the replaced entries read,
 * the selection taken over and the fields built before the per-file loop fills them.
 *
 * @inner
 * @param {string} fn - the text of onUpload
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertSettle(fn, label) {
    assert.equal(count(fn, DROP), 1, label + ': the failure drop');
    assert.equal(count(fn, DROP_LINE), 2, label + ': the pending selection is dropped by a failure and by a success');
    assert.equal(count(fn, EMPTY), 1, label + ': the container is emptied once');
    assert.equal(count(fn, STAGED), 1, label + ': the answer recorded');
    assert.equal(count(fn, REPLACED), 1, label + ': the replaced entries read');
    assert.equal(count(fn, TAKEOVER), 1, label + ': the take-over');
    assert.equal(count(fn, BUILD), 1, label + ': the fields built');
    var drop = fn.indexOf(DROP), errorHead = fn.indexOf(ERROR_HEAD), noSlot = fn.indexOf(NO_SLOT),
        empty = fn.indexOf(EMPTY), staged = fn.indexOf(STAGED), replaced = fn.indexOf(REPLACED),
        takeover = fn.indexOf(TAKEOVER), build = fn.indexOf(BUILD), loop = fn.indexOf(FILE_LOOP),
        fill = fn.indexOf(FILL);
    assert.ok(errorHead > -1 && noSlot > errorHead && loop > -1 && fill > loop, label + ': the anchors of the branches');
    assert.ok(drop < errorHead, label + ': the failure drop comes before the error branch');
    assert.ok(empty > noSlot, label + ': the container is emptied inside the success branch, not before the error branch');
    assert.ok(empty < staged && staged < replaced && replaced < takeover && takeover < build && build < loop,
        label + ': emptied, answer recorded, replaced entries read, selection taken over, fields built, then the per-file loop');
}

describe('#B960 - a staged selection takes the file input over when its staging succeeds', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('01 - source pins (comment-stripped)', function () {
        it('onUpload drops the pending selection on a failure, and empties the container and takes the selection over on a success only', function () {
            assertSettle(onUploadText(code, 'src'), 'src');
        });

        it('the change listener keeps the selection pending and builds no field', function () {
            assert.equal(count(code, PENDING), 1, 'the pending selection');
            assert.equal(count(code, '$el.customFiles ='), 0, 'the listener writes no entry');
            assert.equal(count(code, '_replacedStoredFiles'), 0, 'the #B150 record is gone');
            assert.equal(count(code, 'buildUploadHiddenFields($el,'), 0, 'no field is built at the selection');
            assert.equal(count(code, 'buildUploadHiddenFields('), 1, 'one build, in onUpload');
        });

        it('the selection that creates the virtual upload form binds the reset triggers the page already holds', function () {
            assert.equal(count(code, BIND_RESET), 1);
            var pending = code.indexOf(PENDING), bind = code.indexOf(BIND_RESET);
            assert.ok(pending > -1 && bind > pending, 'the binding sits in the change listener, after the pending selection');
        });

        it('[instrument] the raw source carries the lines the stripped reads count', function () {
            assert.ok(count(src, PENDING) >= 1 && count(src, TAKEOVER) >= 1 && count(src, EMPTY) >= 1 && count(src, BIND_RESET) >= 1,
                'the stripped reads above are not vacuous');
        });

        it('[instrument] the stripped source holds no comment line, the raw holds them', function () {
            assert.ok(count(src, '// was:') > 0, 'the raw source holds was: lines');
            assert.equal(count(code, '// was:'), 0, 'no was: line survives the stripper');
            var raw = fs.readFileSync(DIST_RAW, 'utf8');
            assert.ok(count(raw, '// was:') > 0, 'gina.js: the raw bundle holds was: lines');
            assert.equal(count(stripComments(raw), '// was:'), 0, 'gina.js: no was: line survives the stripper');
        });
    });

    describe('02 - dist fidelity', function () {
        it('the unminified bundle carries the same settle', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assertSettle(onUploadText(raw, 'gina.js'), 'gina.js');
            assert.equal(count(raw, PENDING), 1, 'gina.js: the pending selection');
            assert.equal(count(raw, BIND_RESET), 1, 'gina.js: the reset triggers bound by the creating selection');
        });

        it('the minified bundle carries the pending selection and its take-over', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal(count(min, MIN_PENDING), 1, 'the listener\'s pending write');
            assert.equal(count(min, MIN_TAKEOVER), 1, 'the success\'s take-over');
            assert.equal(count(min, '_replacedStoredFiles'), 0, 'the #B150 record is gone');
        });
    });
});
