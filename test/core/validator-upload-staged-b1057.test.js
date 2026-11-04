'use strict';

/**
 * #B1059 — a failed staging empties the staged file input.
 *
 * `onUpload` settles a staged upload. On a failure it dropped the pending selection (#B960) and
 * left the file input holding it, so the input's value still named the file and choosing that same
 * file again fired `cancel` instead of `change` in Chromium: the file that had failed could not be
 * retried. The failure drop now also empties the input's value. The success branch leaves it alone:
 * there the selection is the input's file.
 *
 * The behaviour is driven in `test/e2e/validator-upload-staged-b1057.spec.js`; these pins hold the
 * shape of the source and of both bundles.
 *
 *  - 01 source pins (comment-stripped): the failure drop empties the value after dropping the pending
 *    selection, and onUpload empties it nowhere else
 *  - 02 dist fidelity: the unminified bundle carries the same drop; the minified one the same pair
 *
 * RED-FIRST: B1057_VALIDATOR_SRC=<a pre-fix main.js> and B1057_PLUGIN_DIST=<a pre-fix dist dir holding
 * js/gina.js and js/gina.min.js> run every pin against those bytes; 01.1, 01.2, 02.1 and 02.2 fail
 * on develop `60fa83d78`, the [instrument] tests pass.
 */

var describe = require('node:test').describe;
var it       = require('node:test').it;
var assert   = require('node:assert/strict');
var fs       = require('fs');
var path     = require('path');

var FW = require('../fw');

var MAIN     = process.env.B1057_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B1057_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var ON_UPLOAD   = 'var onUpload = function(gina, $target, status, id, data) {';
var DROP        = "if ( status != 'success' && $uploadTriger ) {";
var DROP_LINE   = '$uploadTriger.pendingFiles = null;';
var VALUE_CLEAR = "$uploadTriger.value = '';";
var ERROR_HEAD  = "if ($error && status != 'success') {";

// the minified failure drop: the pending selection dropped, then the value emptied, on one input
// (Closure emits `a.pendingFiles=null,a.value=''`; either quote is accepted)
var MIN_DROP = /([\w$]+)\.pendingFiles\s*=\s*null\s*,\s*\1\.value\s*=\s*(?:''|"")/g;

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
 * literals, so a `was:` line or a JSDoc naming a pinned expression cannot satisfy a pin.
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
 * Asserts the failure drop of `onUpload`: one block, before the error branch, that drops the
 * pending selection and then empties the input's value, and no other place in onUpload that
 * empties it.
 *
 * @inner
 * @param {string} fn - the text of onUpload
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertFailureDrop(fn, label) {
    assert.equal(count(fn, DROP), 1, label + ': the failure drop');
    var at = fn.indexOf(DROP), close = fn.indexOf('}', at + DROP.length);
    assert.ok(close > at, label + ': the end of the failure drop');
    var block = fn.slice(at + DROP.length, close);
    assert.ok(fn.indexOf(ERROR_HEAD) > close, label + ': the failure drop comes before the error branch');
    assert.equal(count(block, DROP_LINE), 1, label + ': the drop of the pending selection');
    assert.equal(count(block, VALUE_CLEAR), 1, label + ': the value emptied by the failure drop');
    assert.ok(block.indexOf(DROP_LINE) < block.indexOf(VALUE_CLEAR), label + ': the selection dropped, then the value emptied');
    assert.equal(count(fn, VALUE_CLEAR), 1, label + ': onUpload empties the value nowhere else');
}

describe('#B1059 - a failed staging empties the staged file input', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('01 - source pins (comment-stripped)', function () {
        it('01.1 - the failure drop empties the input after dropping the pending selection', function () {
            assertFailureDrop(onUploadText(code, 'src'), 'src');
        });

        it('01.2 - the success branch leaves the value alone: the selection is the input\'s file', function () {
            var fn = onUploadText(code, 'src');
            var drop = fn.indexOf(DROP), clear = fn.indexOf(VALUE_CLEAR), errorHead = fn.indexOf(ERROR_HEAD);
            assert.ok(clear > drop && clear < errorHead, 'the one value write sits in the failure drop');
        });

        it('[instrument] the raw source carries the lines the stripped reads count', function () {
            assert.ok(count(src, ON_UPLOAD) >= 1 && count(src, DROP) >= 1 && count(src, DROP_LINE) >= 1 && count(src, ERROR_HEAD) >= 1,
                'the stripped reads above are not vacuous');
        });

        it('[instrument] the stripped source holds no comment line, the raw holds them', function () {
            assert.ok(count(src, '// was:') > 0, 'the raw source holds was: lines');
            assert.equal(count(code, '// was:'), 0, 'no was: line survives the stripper');
        });
    });

    describe('02 - dist fidelity', function () {
        it('02.1 - the unminified bundle carries the same failure drop', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assertFailureDrop(onUploadText(raw, 'gina.js'), 'gina.js');
        });

        it('02.2 - the minified bundle drops the pending selection and empties the value of the same input', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal((min.match(MIN_DROP) || []).length, 1, 'one failure drop that also empties the value');
        });

        it('[instrument] the minified bundle still carries the pending drop the pin above extends', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.ok((min.match(/\.pendingFiles\s*=\s*null/g) || []).length >= 2, 'the failure and the success drops survive minification');
        });
    });
});
