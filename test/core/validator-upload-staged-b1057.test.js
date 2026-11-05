'use strict';

/**
 * #B1059, #B1057, #B1058 — the staged file input after a failed staging, after a smaller selection,
 * and under its own rules.
 *
 * #B1059 — `onUpload` settles a staged upload. On a failure it dropped the pending selection (#B960) and
 * left the file input holding it, so the input's value still named the file and choosing that same
 * file again fired `cancel` instead of `change` in Chromium: the file that had failed could not be
 * retried. The failure drop now also empties the input's value. The success branch leaves it alone:
 * there the selection is the input's file.
 *
 * #B1057 — a staged selection with fewer files than the input held left the fields of the indices it
 * no longer has in the form, so the form posted the replaced files beside the new ones. The success
 * branch now takes them out after it builds the fields, as a reset does.
 *
 * #B1058 — a staged file input is collected without its own value (#B725), so no rule of it ran:
 * `isRequired` on it refused nothing. When it has a rule, both collectors now give it the names of the
 * files it holds (getStagedUploadValue), validate() leaves that value out of the data in forEachField's
 * terminal block once every rule of the pass has run, and the gate of its form is re-derived when those
 * files change (resyncStagedUploadGate, at the selection, the staging settle and a reset or a delete).
 *
 * The behaviour is driven in `test/e2e/validator-upload-staged-b1057.spec.js`; these pins hold the
 * shape of the source and of both bundles, and run the shipped helpers.
 *
 *  - 01/02 #B1059: source pins (the failure drop empties the value after dropping the pending selection,
 *    and onUpload empties it nowhere else); dist fidelity, both bundles
 *  - 03/04 #B1057: source pins (the held count, the build, the removal of the stale indices); dist fidelity
 *  - 05 #B1058 source pins: the two collector arms, the inline exclusion in forEachField's terminal block
 *    before the errors are read, the three re-syncs of the gate
 *  - 06 #B1058 the shipped helpers run, extracted from the source: getStagedUploadValue,
 *    resyncStagedUploadGate (instance and re-validation injected) and the exclusion block
 *  - 07 #B1058 the unminified bundle: the pins of 05 and the runs of 06 on gina.js
 *  - 08 #B1058 the minified bundle: shapes derived from the artifact (names captured, `\s*` at every
 *    token boundary, either quote), and the same three runs on the minified functions
 *
 * RED-FIRST: B1057_VALIDATOR_SRC=<a pre-fix main.js> and B1057_PLUGIN_DIST=<a pre-fix dist dir holding
 * js/gina.js and js/gina.min.js> run every pin against those bytes (measured 2026-11-04 on the per-fix
 * states of the arc): on develop `60fa83d78` 19 of 28 fail (all but 03.2, the one build #B960 already
 * held, and the eight [instrument] tests); with #B1059 alone 15 fail (03.1, 04.1, 04.2 and 05–08); with
 * #B1059 and #B1057, 12 (05–08); with all three, none. The minified pins also passed on a copy of the
 * bundle with a line break at every token boundary of their regions, and 08.3 failed on a copy whose
 * exclusion reads `exclude(!1)`.
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

// #B1057 — the success branch: the count held before the take-over, the build, then the removal of
// the indices the new selection no longer has, before the per-file loop fills the fields
var TAKEOVER     = '$uploadTriger.customFiles = $uploadTriger.pendingFiles || [];';
var BUILD        = 'uploadProperties.uploadFields = buildUploadHiddenFields($uploadTriger, getUploadFieldPrefix($uploadTriger), files.length, uploadProperties.mandatoryFields, false);';
var FILE_LOOP    = 'for (var f = 0, fLen = files.length; f<fLen; ++f) {';
var HELD         = 'var heldFilesCount = ( $uploadTriger.customFiles || [] ).length;';
var STALE_LOOP   = 'for (var staleIndex = files.length; staleIndex < heldFilesCount; ++staleIndex) {';
var STALE_REMOVE = 'removeUploadEntryFields($uploadTriger, getUploadFieldPrefix($uploadTriger), staleIndex);';
// the minified held count `b=(a.customFiles||[]).length`, and the loop `f=x.length;f<b;++f)zb(a,Ra(a),f)`
var MIN_HELD  = /([\w$]+)\s*=\s*\(\s*([\w$]+)\.customFiles\s*\|\|\s*\[\]\s*\)\.length/g;
var MIN_STALE = /([\w$]+)\s*=\s*[\w$]+\.length\s*;\s*\1\s*<\s*([\w$]+)\s*;\s*\+\+\s*\1\s*\)\s*([\w$]+)\(\s*([\w$]+)\s*,\s*[\w$]+\(\s*\4\s*\)\s*,\s*\1\s*\)/g;

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

/**
 * Asserts the take-over of `onUpload`'s success branch: the count of files the input held is read
 * before the take-over, and after the fields are built, the fields of every index from the new
 * selection's length up to that count are taken out of the form, still inside the block that
 * builds them, before the per-file loop fills the fields.
 *
 * @inner
 * @param {string} fn - the text of onUpload
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertStaleRemoval(fn, label) {
    assert.equal(count(fn, HELD), 1, label + ': the held count');
    assert.equal(count(fn, TAKEOVER), 1, label + ': the take-over');
    assert.equal(count(fn, BUILD), 1, label + ': the build');
    assert.equal(count(fn, STALE_LOOP), 1, label + ': the loop over the stale indices');
    assert.equal(count(fn, STALE_REMOVE), 1, label + ': the removal of a stale index');
    var held = fn.indexOf(HELD), takeover = fn.indexOf(TAKEOVER), build = fn.indexOf(BUILD),
        staleLoop = fn.indexOf(STALE_LOOP), staleRemove = fn.indexOf(STALE_REMOVE), loop = fn.indexOf(FILE_LOOP);
    assert.ok(loop > -1, label + ': the per-file loop');
    assert.ok(held < takeover, label + ': the held count is read before the take-over replaces the entries');
    assert.ok(takeover < build && build < staleLoop && staleLoop < staleRemove && staleRemove < loop,
        label + ': taken over, built, then the stale indices removed, before the per-file loop');
    assert.equal(fn.slice(build, staleLoop).indexOf('}'), -1, label + ': the removal sits in the block that builds the fields');
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

describe('#B1057 - a smaller selection takes out the fields of the indices it no longer has', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('03 - source pins (comment-stripped)', function () {
        it('03.1 - the held count is read before the take-over, and the stale indices are removed after the build', function () {
            assertStaleRemoval(onUploadText(code, 'src'), 'src');
        });

        it('03.2 - the build stays the one build of the fields (#B960)', function () {
            assert.equal(count(code, 'buildUploadHiddenFields('), 1);
        });

        it('[instrument] the raw source carries the anchors the stripped reads use', function () {
            assert.ok(count(src, TAKEOVER) >= 1 && count(src, BUILD) >= 1 && count(src, FILE_LOOP) >= 1,
                'the stripped reads above are not vacuous');
        });
    });

    describe('04 - dist fidelity', function () {
        it('04.1 - the unminified bundle carries the same take-over', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assertStaleRemoval(onUploadText(raw, 'gina.js'), 'gina.js');
        });

        it('04.2 - the minified bundle reads the held count and removes the indices up to it, on the same input', function () {
            // Closure emits `b=(a.customFiles||[]).length` and folds the build into the loop:
            // `for(c.uploadFields=Kb(…),f=x.length;f<b;++f)zb(a,Ra(a),f)`. The names change with every
            // build, so the two shapes are matched apart and tied by the names they capture.
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var held  = Array.from(min.matchAll(MIN_HELD));
            var stale = Array.from(min.matchAll(MIN_STALE));
            assert.equal(held.length, 1, 'one held count');
            assert.equal(stale.length, 1, 'one loop over the stale indices');
            assert.equal(stale[0][2], held[0][1], 'the loop runs up to the held count');
            assert.equal(stale[0][4], held[0][2], 'and removes the indices of the input the count was read from');
        });
    });
});

// #B1058 — a staged file input that has a rule is judged on the files it holds, its value never sent,
// and the gate of its form follows those files
var STAGED_DECL    = 'var getStagedUploadValue = function($input) {';
var GATE_DECL      = 'var resyncStagedUploadGate = function($input) {';
var FOR_EACH_FIELD = 'var forEachField = function($formOrElement, allFields, allRules, fields, $fields, rules, cb, i) {';
var TERMINAL       = 'if (i <= 0 && subLevelRules < 0) {';
var GET_ERRORS     = "var errors = d['getErrors']();";
var RESET_DECL     = 'var onUploadResetOrDelete = function($uploadTrigger, bindingType) {';

// the exclusion, written inline in forEachField's terminal block (a helper call there breaks the
// suites that lift forEachField into a harness)
var EXCLUSION = /if\s*\(\s*\$fields\s*\)\s*\{\s*for\s*\(\s*var\s+stagedName\s+in\s+\$fields\s*\)\s*\{\s*if\s*\(\s*\$fields\[stagedName\]\s*&&\s*\$fields\[stagedName\]\.type\s*==\s*'file'\s*&&\s*typeof\(\$fields\[stagedName\]\.getAttribute\)\s*==\s*'function'\s*&&\s*\$fields\[stagedName\]\.getAttribute\('data-gina-form-upload-action'\)\s*&&\s*d\[stagedName\]\s*&&\s*typeof\(d\[stagedName\]\.exclude\)\s*==\s*'function'\s*\)\s*\{\s*d\[stagedName\]\.exclude\(true\)\s*;\s*\}\s*\}\s*\}/g;

// the three re-syncs of the gate: at the selection, as onUpload's last statement, after a reset or a delete
var GATE_AT_SELECTION = /\$el\.pendingFiles\s*=\s*Array\.from\(\s*files\s*\)\s*;\s*resyncStagedUploadGate\(\s*\$el\s*\)\s*;/g;
var GATE_AT_SETTLE    = /if\s*\(\s*\$uploadTriger\s*\)\s*\{\s*resyncStagedUploadGate\(\s*\$uploadTriger\s*\)\s*;\s*\}\s*\}\s*;?\s*$/;
var GATE_AT_REMOVAL   = /\$uploadTrigger\.customFiles\s*=\s*remainingFiles\s*;\s*if\s*\(\s*isOnResetMode\s*\)\s*\{[^{}]*\}\s*resyncStagedUploadGate\(\s*\$uploadTrigger\s*\)\s*;/g;

// the minified shapes, derived from the built artifact (Closure renames every local, so the names are
// captured and tied by backreferences; `\s*` at every token boundary, either quote)
var MIN_STAGED_LISTS = /\[\s*([\w$]+)\s*\.\s*customFiles\s*,\s*\1\s*\.\s*pendingFiles\s*\]/g;
var MIN_GATE_HEAD    = /([\w$]+)\s*=\s*function\s*\(\s*([\w$]+)\s*\)\s*\{\s*var\s+[\w$]+\s*=\s*\2\s*&&\s*\2\s*\.\s*form\s*\?\s*\2\s*\.\s*form\s*:\s*null/g;
// `if($fields)for(var k in fields)$fields[k]&&…&&d[k].exclude(!0);x=d.getErrors()`
var MIN_EXCLUSION = /if\s*\(\s*([\w$]+)\s*\)\s*(for\s*\(\s*(?:var\s+)?([\w$]+)\s+in\s+([\w$]+)\s*\)\s*\1\s*\[\s*\3\s*\]\s*&&\s*\1\s*\[\s*\3\s*\]\s*\.\s*type\s*==\s*(['"])file\5\s*&&\s*typeof\s+\1\s*\[\s*\3\s*\]\s*\.\s*getAttribute\s*==\s*(['"])function\6\s*&&\s*\1\s*\[\s*\3\s*\]\s*\.\s*getAttribute\s*\(\s*(['"])data-gina-form-upload-action\7\s*\)\s*&&\s*([\w$]+)\s*\[\s*\3\s*\]\s*&&\s*typeof\s+\8\s*\[\s*\3\s*\]\s*\.\s*exclude\s*==\s*(['"])function\9\s*&&\s*\8\s*\[\s*\3\s*\]\s*\.\s*exclude\s*\(\s*!\s*0\s*\))\s*;\s*[\w$]+\s*=\s*\8\s*\.\s*getErrors\s*\(\s*\)/g;
// the test of the staged branch of both collectors, before and after the fix (the instrument of the pins
// below): before it the empty branch is emitted as `…getAttribute('data-gina-form-upload-action')||(…=….value)`,
// after it as a ternary
var MIN_STAGED_BRANCH = /([\w$]+)\s*\[\s*([\w$]+)\s*\]\s*\.\s*type\s*==\s*(['"])file\3\s*&&\s*\1\s*\[\s*\2\s*\]\s*\.\s*getAttribute\s*\(\s*(['"])data-gina-form-upload-action\4\s*\)/g;

/**
 * Escapes a name for a RegExp: a minified name may hold `$`.
 *
 * @inner
 * @param {string} name - the name
 * @returns {string} the name, escaped
 */
function escapeRe(name) { return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The staged branch of the source collector that reads `<list>[i]`: a staged file input gives a value
 * only when it has a rule, the names of the files it holds; any other control still gives its own value.
 *
 * @inner
 * @param {string} list - `$target` (the submit proxy's loop) or `$form` (getFormValidationInfos)
 * @returns {RegExp} the branch, whitespace-agnostic, from its `else if` to the plain branch's assignment
 */
function collectorArm(list) {
    var L = '\\' + list + '\\[i\\]';
    return new RegExp(
        'else\\s+if\\s*\\(\\s*' + L + '\\.type\\s*==\\s*\'file\'\\s*&&\\s*' + L + '\\.getAttribute\\(\'data-gina-form-upload-action\'\\)\\s*\\)\\s*\\{'
        + '\\s*if\\s*\\(\\s*rules\\s*&&\\s*typeof\\(rules\\[name\\]\\)\\s*!=\\s*\'undefined\'\\s*\\)\\s*\\{'
        + '\\s*fields\\[name\\]\\s*=\\s*getStagedUploadValue\\(\\s*' + L + '\\s*\\)\\s*;\\s*\\}'
        + '\\s*\\}\\s*else\\s*\\{\\s*fields\\[name\\]\\s*=\\s*' + L + '\\.value\\s*;\\s*\\}',
        'g');
}

/**
 * The staged branch of a minified collector, tied by backreferences: the control the branch tests is
 * the one whose files `<alias>` reads, under the name the rule check reads, written into the fields
 * the plain branch writes.
 *
 * @inner
 * @param {string} alias - the minified name of getStagedUploadValue
 * @returns {RegExp} the branch, from the type test to the plain branch's `.value`
 */
function minCollectorArm(alias) {
    return new RegExp(
        '([\\w$]+)\\s*\\[\\s*([\\w$]+)\\s*\\]\\s*\\.\\s*type\\s*==\\s*([\'"])file\\3\\s*&&\\s*\\1\\s*\\[\\s*\\2\\s*\\]\\s*\\.\\s*getAttribute\\s*\\(\\s*([\'"])data-gina-form-upload-action\\4\\s*\\)\\s*\\?\\s*'
        + '([\\w$]+)\\s*&&\\s*typeof\\s+\\5\\s*\\[\\s*([\\w$]+)\\s*\\]\\s*!=\\s*([\'"])undefined\\7\\s*&&\\s*'
        + '\\(\\s*([\\w$]+)\\s*\\[\\s*\\6\\s*\\]\\s*=\\s*' + escapeRe(alias) + '\\s*\\(\\s*\\1\\s*\\[\\s*\\2\\s*\\]\\s*\\)\\s*\\)\\s*:\\s*'
        + '\\8\\s*\\[\\s*\\6\\s*\\]\\s*=\\s*\\1\\s*\\[\\s*\\2\\s*\\]\\s*\\.\\s*value',
        'g');
}

/**
 * The text of the function whose `function` keyword starts at `from`, to its closing brace: a
 * started-flag brace walk. It counts every brace, so it serves a function whose string and regex
 * literals hold none (the three extracted here; comments are stripped before the walk).
 *
 * @inner
 * @param {string} code - the text
 * @param {number} from - the index of the `function` keyword
 * @param {string} label - names the text in the messages
 * @returns {string} the function's text
 */
function functionAt(code, from, label) {
    assert.equal(code.slice(from, from + 8), 'function', label + ': a function starts at the anchor');
    var depth = 0, started = false;
    for (var i = from; i < code.length; ++i) {
        if (code[i] === '{') { depth++; started = true; }
        else if (code[i] === '}') {
            depth--;
            if (started && depth === 0) { return code.slice(from, i + 1); }
        }
    }
    throw new Error(label + ': unbalanced braces');
}

/**
 * The text of a declared source function (`var <name> = function(…) {`), declared once.
 *
 * @inner
 * @param {string} code - the comment-stripped source
 * @param {string} decl - the declaration line
 * @param {string} label - names the text in the messages
 * @returns {string} the function's text
 */
function sourceFunction(code, decl, label) {
    assert.equal(count(code, decl), 1, label + ': one declaration');
    var at = code.indexOf(decl);
    return functionAt(code, at + decl.indexOf('function'), label);
}

/**
 * The text of the exclusion block of a source: the inline loop of forEachField's terminal block.
 *
 * @inner
 * @param {string} code - the comment-stripped source
 * @param {string} label - names the text in the messages
 * @returns {string} the block's text
 */
function exclusionText(code, label) {
    var terminal = code.indexOf(TERMINAL), errors = code.indexOf(GET_ERRORS);
    var found = code.slice(terminal + TERMINAL.length, errors).match(EXCLUSION) || [];
    assert.equal(found.length, 1, label + ': the exclusion block');
    return found[0];
}

/**
 * A file the way an input holds it: a `File` where the runtime has one, else its shape.
 *
 * @inner
 * @param {string} name - the file's name
 * @returns {File|{name: string}} the file
 */
function makeFile(name) { return ( typeof(File) == 'function' ) ? new File(['x'], name) : { name: name }; }

/**
 * The cases getStagedUploadValue and its minified twin are run on: what the input holds, and the value
 * a rule of it judges.
 *
 * @constant
 * @type {Array<{label: string, input: function(): object, expect: string}>}
 */
var STAGED_CASES = [
    { label: 'nothing held',                          expect: '',             input: function () { return {}; } },
    { label: 'empty lists',                           expect: '',             input: function () { return { customFiles: [], pendingFiles: [] }; } },
    { label: 'dropped lists',                         expect: '',             input: function () { return { customFiles: null, pendingFiles: null }; } },
    { label: 'one staged file',                       expect: 'a.png',        input: function () { return { customFiles: [ makeFile('a.png') ] }; } },
    { label: 'two staged files, in order',            expect: 'a.png, b.png', input: function () { return { customFiles: [ makeFile('a.png'), makeFile('b.png') ] }; } },
    { label: 'a saved file of an edit form',          expect: 'saved.pdf',    input: function () { return { customFiles: [ { name: 'saved.pdf', deleteLinkId: 'avatar-0-delete-trigger' } ] }; } },
    { label: 'a selection still staging',             expect: 'c.png',        input: function () { return { pendingFiles: [ makeFile('c.png') ] }; } },
    { label: 'the entries, then the selection',       expect: 'a.png, c.png', input: function () { return { customFiles: [ makeFile('a.png') ], pendingFiles: [ makeFile('c.png') ] }; } },
    { label: 'holes and nameless entries skipped',    expect: 'd.png',        input: function () { return { customFiles: [ null, { name: '' }, {}, makeFile('d.png') ] }; } }
];

/**
 * Runs a getStagedUploadValue over STAGED_CASES.
 *
 * @inner
 * @param {function(object): string} fn - the helper
 * @returns {Array<string>} its value per case
 */
function runStaged(fn) { return STAGED_CASES.map(function (c) { return fn(c.input()); }); }

/**
 * A form as the gate reads it: its `id` attribute.
 *
 * @inner
 * @param {?string} id - the form's id
 * @returns {{getAttribute: function(string): ?string}} the form
 */
function formOf(id) { return { getAttribute: function (n) { return n === 'id' ? id : null; } }; }

/**
 * The scenes resyncStagedUploadGate and its minified twin are run in: the plugin instance, the form
 * record, the input; `expect` lists the records the gate re-validates.
 *
 * @constant
 * @type {Array<{label: string, expect: Array<string>, scene: function(): object}>}
 */
var GATE_CASES = [
    { label: 'a staged input with a rule: its form is re-validated', expect: [ 'record' ], scene: function () {
        var record = { rules: { avatar: { isRequired: true } } };
        return { record: record, instance: { $forms: { f1: record } }, input: { name: 'avatar', form: formOf('f1') } };
    } },
    { label: 'no rule for the input', expect: [], scene: function () {
        var record = { rules: { title: { isRequired: true } } };
        return { record: record, instance: { $forms: { f1: record } }, input: { name: 'avatar', form: formOf('f1') } };
    } },
    { label: 'a form without an id', expect: [], scene: function () {
        var record = { rules: { avatar: { isRequired: true } } };
        return { record: record, instance: { $forms: { f1: record } }, input: { name: 'avatar', form: formOf(null) } };
    } },
    { label: 'a form the plugin does not hold', expect: [], scene: function () {
        return { record: null, instance: { $forms: {} }, input: { name: 'avatar', form: formOf('f1') } };
    } },
    { label: 'a record without rules', expect: [], scene: function () {
        var record = {};
        return { record: record, instance: { $forms: { f1: record } }, input: { name: 'avatar', form: formOf('f1') } };
    } },
    { label: 'an input outside any form', expect: [], scene: function () {
        return { record: null, instance: { $forms: {} }, input: { name: 'avatar', form: null } };
    } },
    { label: 'no input', expect: [], scene: function () {
        return { record: null, instance: { $forms: {} }, input: null };
    } }
];

/**
 * Runs a gate over GATE_CASES.
 *
 * @inner
 * @param {function(object, function): function} build - makes the gate from the instance and the re-validation it calls
 * @returns {Array<Array<string>>} the records re-validated, per case
 */
function runGate(build) {
    return GATE_CASES.map(function (c) {
        var calls = [], scene = c.scene();
        var gate = build(scene.instance, function (record) { calls.push(record === scene.record ? 'record' : 'another'); });
        gate(scene.input);
        return calls;
    });
}

/**
 * A control as the exclusion reads it: its type and its upload action.
 *
 * @inner
 * @param {string} type - the control's type
 * @param {?string} action - its `data-gina-form-upload-action`, or null
 * @returns {{type: string, getAttribute: function(string): ?string}} the control
 */
function controlOf(type, action) {
    return { type: type, getAttribute: function (n) { return n === 'data-gina-form-upload-action' ? action : null; } };
}

/**
 * An engine field that logs its exclusions.
 *
 * @inner
 * @param {Array<string>} log - receives `<name>:<argument>` per exclusion
 * @param {string} name - the field's name
 * @returns {{exclude: function(boolean): void}} the field
 */
function engineField(log, name) { return { exclude: function (v) { log.push(name + ':' + v); } }; }

/**
 * The passes the exclusion block and its minified twin are run on: the collected values, the controls,
 * the engine; `expect` lists the exclusions made.
 *
 * @constant
 * @type {Array<{label: string, expect: Array<string>, scene: function(Array<string>): object}>}
 */
var EXCLUSION_CASES = [
    { label: 'a staged input is left out; a text field and a plain file input are kept; one without an engine field, or without getAttribute, is skipped', expect: [ 'avatar:true' ], scene: function (log) {
        return {
            fields:  { avatar: 'a.png', title: 't', plain: 'C:\\fakepath\\p.png', ghost: 'g.png', bare: 'b.png' },
            $fields: { avatar: controlOf('file', '/upload/avatar'), title: controlOf('text', null), plain: controlOf('file', null), ghost: controlOf('file', '/upload/ghost'), bare: { type: 'file' } },
            d:       { avatar: engineField(log, 'avatar'), title: engineField(log, 'title'), plain: engineField(log, 'plain'), bare: engineField(log, 'bare') }
        };
    } },
    { label: 'two staged inputs are both left out', expect: [ 'avatar:true', 'cv:true' ], scene: function (log) {
        return {
            fields:  { avatar: 'a.png', cv: '' },
            $fields: { avatar: controlOf('file', '/upload/avatar'), cv: controlOf('file', '/upload/cv') },
            d:       { avatar: engineField(log, 'avatar'), cv: engineField(log, 'cv') }
        };
    } },
    { label: 'a pass without controls (the server\'s) leaves nothing out', expect: [], scene: function (log) {
        return { fields: { avatar: 'a.png' }, $fields: null, d: { avatar: engineField(log, 'avatar') } };
    } }
];

/**
 * Runs an exclusion block over EXCLUSION_CASES.
 *
 * @inner
 * @param {function(object, object, object): void} block - the block, as a function of (fields, $fields, d)
 * @returns {Array<Array<string>>} the exclusions made, per case
 */
function runExclusion(block) {
    return EXCLUSION_CASES.map(function (c) {
        var log = [], s = c.scene(log);
        block(s.fields, s.$fields, s.d);
        return log;
    });
}

/**
 * Asserts the #B1058 shape of a source (main.js, or the unminified bundle that carries it): the two
 * collector arms, the exclusion in forEachField's terminal block before the errors are read, and the
 * three re-syncs of the gate.
 *
 * @inner
 * @param {string} code - the comment-stripped text
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertStagedRuleShape(code, label) {
    assert.equal((code.match(collectorArm('$target')) || []).length, 1, label + ': the submit proxy collects a staged input that has a rule');
    assert.equal((code.match(collectorArm('$form')) || []).length, 1, label + ': getFormValidationInfos collects it the same way');
    assert.equal(count(code, 'getStagedUploadValue('), 2, label + ': the two collectors are its only callers');

    assert.equal(count(code, FOR_EACH_FIELD), 1, label + ': forEachField');
    assert.equal(count(code, TERMINAL), 1, label + ': its terminal block');
    assert.equal(count(code, GET_ERRORS), 1, label + ': the errors read');
    var head = code.indexOf(FOR_EACH_FIELD), terminal = code.indexOf(TERMINAL), errors = code.indexOf(GET_ERRORS);
    assert.ok(head < terminal && terminal < errors, label + ': forEachField, its terminal block, then the errors read');
    exclusionText(code, label);
    assert.equal(count(code, '.exclude('), 1, label + ': the one exclusion of the client');

    assert.equal(count(code, 'resyncStagedUploadGate('), 3, label + ': three re-syncs of the gate');
    assert.equal((code.match(GATE_AT_SELECTION) || []).length, 1, label + ': at the selection, after the pending write');
    assert.ok(GATE_AT_SETTLE.test(onUploadText(code, label)), label + ': as the last statement of onUpload');
    assert.equal(count(code, RESET_DECL), 1, label + ': onUploadResetOrDelete');
    var reset = code.indexOf(RESET_DECL), resetEnd = code.indexOf('\n    var ', reset + RESET_DECL.length);
    assert.ok(resetEnd > reset, label + ': the end of onUploadResetOrDelete');
    assert.equal((code.slice(reset, resetEnd).match(GATE_AT_REMOVAL) || []).length, 1, label + ': in onUploadResetOrDelete, after the entries are updated');
}

/**
 * Asserts the three runs of #B1058 on functions taken from a source: getStagedUploadValue, the gate
 * (with the instance and the re-validation injected) and the exclusion block.
 *
 * @inner
 * @param {string} code - the comment-stripped text
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertStagedRuleRuns(code, label) {
    var staged = new Function('return (' + sourceFunction(code, STAGED_DECL, label + ' getStagedUploadValue') + ');')();
    assert.deepEqual(runStaged(staged), STAGED_CASES.map(function (c) { return c.expect; }), label + ': getStagedUploadValue');

    var gateText = sourceFunction(code, GATE_DECL, label + ' resyncStagedUploadGate');
    assert.deepEqual(runGate(function (instance, revalidate) {
        return new Function('instance', 'revalidateSilently', 'return (' + gateText + ');')(instance, revalidate);
    }), GATE_CASES.map(function (c) { return c.expect; }), label + ': resyncStagedUploadGate');

    var block = exclusionText(code, label);
    assert.deepEqual(runExclusion(new Function('fields', '$fields', 'd', block)), EXCLUSION_CASES.map(function (c) { return c.expect; }), label + ': the exclusion block');
}

describe('#B1058 - a staged file input that has a rule is judged on the files it holds', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('05 - source pins (comment-stripped)', function () {
        it('05.1 - both collectors give a staged input that has a rule the names of the files it holds, and only that', function () {
            assert.equal((code.match(collectorArm('$target')) || []).length, 1, 'the submit proxy');
            assert.equal((code.match(collectorArm('$form')) || []).length, 1, 'getFormValidationInfos');
            assert.equal(count(code, 'getStagedUploadValue('), 2, 'no other caller');
        });

        it('05.2 - the value leaves the data in forEachField\'s terminal block, inline, before the errors are read', function () {
            var head = code.indexOf(FOR_EACH_FIELD), terminal = code.indexOf(TERMINAL), errors = code.indexOf(GET_ERRORS);
            assert.ok(head > -1 && head < terminal && terminal < errors, 'forEachField, its terminal block, then the errors read');
            exclusionText(code, 'src');
            assert.equal(count(code, '.exclude('), 1, 'the one exclusion of the client');
        });

        it('05.3 - the gate is re-synced at the selection, at the staging settle and after a reset or a delete', function () {
            assertStagedRuleShape(code, 'src');
        });

        it('[instrument] the raw source carries the anchors the stripped reads use', function () {
            assert.ok(count(src, FOR_EACH_FIELD) >= 1 && count(src, TERMINAL) >= 1 && count(src, GET_ERRORS) >= 1 && count(src, RESET_DECL) >= 1,
                'the anchors of the terminal block and of onUploadResetOrDelete');
            assert.ok(count(src, "else if ( $target[i].type == 'file' && $target[i].getAttribute('data-gina-form-upload-action') ) {") >= 1
                && count(src, "else if ( $form[i].type == 'file' && $form[i].getAttribute('data-gina-form-upload-action') ) {") >= 1,
                'the staged branch of both collectors');
            assert.ok(count(src, '$el.pendingFiles = Array.from(files);') >= 1 && count(src, '$uploadTrigger.customFiles  = remainingFiles;') >= 1,
                'the pending write and the entries update');
        });
    });

    describe('06 - the shipped helpers run (extracted from the source)', function () {
        it('06.1 - getStagedUploadValue: the names of the entries, then of the selection still staging, or \'\'', function () {
            var staged = new Function('return (' + sourceFunction(code, STAGED_DECL, 'src getStagedUploadValue') + ');')();
            STAGED_CASES.forEach(function (c) {
                assert.equal(staged(c.input()), c.expect, c.label);
            });
        });

        it('06.2 - resyncStagedUploadGate: re-validates the form of an input that has a rule, and nothing else', function () {
            var gateText = sourceFunction(code, GATE_DECL, 'src resyncStagedUploadGate');
            var got = runGate(function (instance, revalidate) {
                return new Function('instance', 'revalidateSilently', 'return (' + gateText + ');')(instance, revalidate);
            });
            GATE_CASES.forEach(function (c, i) { assert.deepEqual(got[i], c.expect, c.label); });
        });

        it('06.3 - the exclusion block: leaves out every staged input that has an engine field, and nothing else', function () {
            var got = runExclusion(new Function('fields', '$fields', 'd', exclusionText(code, 'src')));
            EXCLUSION_CASES.forEach(function (c, i) { assert.deepEqual(got[i], c.expect, c.label); });
        });

        it('[instrument] the brace walk refuses an unbalanced text', function () {
            assert.throws(function () { functionAt('function () { if (a) {', 0, 'probe'); }, /unbalanced braces/);
        });

        it('[instrument] each table tells a wrong helper from the shipped one', function () {
            var staged = runStaged(function ($i) {
                return ( $i.customFiles || [] ).filter(function (e) { return e && e.name; }).map(function (e) { return e.name; }).join(', ');
            });
            assert.notDeepEqual(staged, STAGED_CASES.map(function (c) { return c.expect; }), 'a helper that ignores the selection still staging');
            var gate = runGate(function (instance, revalidate) {
                return function ($i) { if ($i && $i.form && instance.$forms[$i.form.getAttribute('id')]) { revalidate(instance.$forms[$i.form.getAttribute('id')]); } };
            });
            assert.notDeepEqual(gate, GATE_CASES.map(function (c) { return c.expect; }), 'a gate that ignores the rule');
            var excluded = runExclusion(function (fields, $fields, d) {
                if (!$fields) { return; }
                for (var k in fields) { if ($fields[k] && $fields[k].type == 'file' && d[k]) { d[k].exclude(true); } }
            });
            assert.notDeepEqual(excluded, EXCLUSION_CASES.map(function (c) { return c.expect; }), 'an exclusion of every file input');
        });
    });

    describe('07 - dist fidelity, unminified bundle', function () {
        it('07.1 - gina.js carries the same collectors, exclusion and re-syncs', function () {
            assertStagedRuleShape(stripComments(fs.readFileSync(DIST_RAW, 'utf8')), 'gina.js');
        });

        it('07.2 - the helpers taken from gina.js run as the source\'s do', function () {
            assertStagedRuleRuns(stripComments(fs.readFileSync(DIST_RAW, 'utf8')), 'gina.js');
        });
    });

    describe('08 - dist fidelity, minified bundle (shapes derived from the artifact)', function () {
        it('08.1 - getStagedUploadValue: one function reads both lists, and its minified text runs as the source\'s', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var lists = Array.from(min.matchAll(MIN_STAGED_LISTS));
            assert.equal(lists.length, 1, 'one read of [customFiles, pendingFiles]');
            var start = min.lastIndexOf('function', lists[0].index);
            var text  = functionAt(min, start, 'gina.min.js getStagedUploadValue');
            assert.ok(start + text.length > lists[0].index, 'the function encloses the read');
            assert.ok(/[\w$]+\s*=\s*$/.test(min.slice(Math.max(0, start - 64), start)), 'the function is assigned to a name');
            assert.deepEqual(runStaged(new Function('return (' + text + ');')()), STAGED_CASES.map(function (c) { return c.expect; }));
        });

        it('08.2 - both collectors call it on the control their staged branch tests, under the rule check', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var lists = Array.from(min.matchAll(MIN_STAGED_LISTS));
            assert.equal(lists.length, 1, 'one read of [customFiles, pendingFiles]');
            var start = min.lastIndexOf('function', lists[0].index);
            var alias = /([\w$]+)\s*=\s*$/.exec(min.slice(Math.max(0, start - 64), start));
            assert.ok(alias, 'the name of getStagedUploadValue');
            assert.equal((min.match(minCollectorArm(alias[1])) || []).length, 2, 'the two collectors');
        });

        it('08.3 - the exclusion runs in the pass before the errors are read from the same engine, and runs as the source\'s', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var found = Array.from(min.matchAll(MIN_EXCLUSION));
            assert.equal(found.length, 1, 'one exclusion, followed by the errors read');
            var m = found[0];
            var block = new Function(m[4], m[1], m[8], 'if (' + m[1] + ') ' + m[2] + ';');
            assert.deepEqual(runExclusion(block), EXCLUSION_CASES.map(function (c) { return c.expect; }));
        });

        it('08.4 - the gate: one function, which calls the re-validation of the live check, at the three sites, and runs as the source\'s', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            var heads = Array.from(min.matchAll(MIN_GATE_HEAD));
            assert.equal(heads.length, 1, 'one gate');
            var alias = heads[0][1], param = heads[0][2];
            var text  = functionAt(min, heads[0].index + heads[0][0].indexOf('function'), 'gina.min.js resyncStagedUploadGate');
            var inst  = /typeof\s+([\w$]+)\s*\.\s*\$forms\s*\[/.exec(text);
            assert.ok(inst, 'it reads the plugin\'s forms');
            var tail  = new RegExp('\\.\\s*rules\\s*\\[\\s*' + escapeRe(param) + '\\s*\\.\\s*name\\s*\\]\\s*!=\\s*([\'"])undefined\\1\\s*&&\\s*([\\w$]+)\\s*\\(\\s*[\\w$]+\\s*\\)\\s*\\}$').exec(text);
            assert.ok(tail, 'it calls a function when a rule names the input');
            var revalidate = tail[2];

            var defs = Array.from(min.matchAll(new RegExp('(?:^|[^\\w$.])' + escapeRe(revalidate) + '\\s*=\\s*function\\s*\\(', 'g')));
            assert.equal(defs.length, 1, 'that function is defined once');
            var revalidateText = functionAt(min, defs[0].index + defs[0][0].lastIndexOf('function'), 'gina.min.js revalidateSilently');
            assert.ok(count(revalidateText, 'ginaFormLiveCheckEnabled') >= 1 && count(revalidateText, 'isSilentPass') >= 1,
                'it is the silent re-validation of the live check');

            var A = escapeRe(alias);
            assert.equal((min.match(new RegExp('([\\w$]+)\\s*\\.\\s*pendingFiles\\s*=\\s*Array\\s*\\.\\s*from\\s*\\(\\s*[\\w$]+\\s*\\)\\s*;\\s*' + A + '\\s*\\(\\s*\\1\\s*\\)', 'g')) || []).length, 1,
                'at the selection, after the pending write');
            assert.equal((min.match(new RegExp('fadeIn\\s*\\(\\s*[\\w$]+\\s*\\)\\s*\\}\\s*\\}\\s*([\\w$]+)\\s*&&\\s*' + A + '\\s*\\(\\s*\\1\\s*\\)\\s*\\}', 'g')) || []).length, 1,
                'at the end of onUpload, after the per-file loop');
            assert.equal((min.match(new RegExp('([\\w$]+)\\s*\\.\\s*customFiles\\s*=\\s*[\\w$]+\\s*;\\s*[\\w$]+\\s*&&\\s*\\(\\s*\\1\\s*\\.\\s*value\\s*=\\s*(?:\'\'|"")\\s*,\\s*\\1\\s*\\.\\s*stagedFiles\\s*=\\s*\\[\\s*\\]\\s*\\)\\s*;\\s*' + A + '\\s*\\(\\s*\\1\\s*\\)', 'g')) || []).length, 1,
                'after a reset or a delete updates the entries');

            var got = runGate(function (instance, revalidateFn) {
                return new Function(inst[1], revalidate, 'return (' + text + ');')(instance, revalidateFn);
            });
            assert.deepEqual(got, GATE_CASES.map(function (c) { return c.expect; }));
        });

        it('[instrument] the minified bundle carries the staged branches and the errors read the pins extend', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.ok((min.match(MIN_STAGED_BRANCH) || []).length >= 2, 'the staged branch of both collectors');
            assert.ok((min.match(/\.\s*getErrors\s*\(\s*\)/g) || []).length >= 1, 'the errors read');
            assert.ok((min.match(/\.\s*pendingFiles\s*=\s*Array\s*\.\s*from\s*\(/g) || []).length >= 1, 'the pending write');
        });
    });
});
