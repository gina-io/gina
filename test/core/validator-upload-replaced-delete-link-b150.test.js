'use strict';
/**
 * FormValidator - the delete link of a stored file a selection replaces (#B150)
 *
 * In an edit form, the bind-time scan records each stored file with the id of its delete link
 * (`<input id>-<index>-delete-trigger`), and a selection replaces those entries with the chosen
 * files. The staging success empties the preview container, which takes a delete link placed
 * inside it, never one placed after it — the shape the uploads guide documents — so that link
 * stayed on the page, bound to an entry the input no longer held: a click sent nothing, removed
 * nothing, and logged the zero-match warning. Since the fix the staging success removes their links,
 * as a delete removes a link. The fix first kept the replaced entries on the input from the change
 * listener (`_replacedStoredFiles`); since #B960 the selection takes the input over only when its
 * staging succeeds, so the success reads the replaced entries from the input's entries itself,
 * removes their links, then takes the selection over (`customFiles` from `pendingFiles`).
 *
 * Strategy:
 *  - 01 source pins on the shipped `main.js`, comment-stripped: the staging success reads the
 *    replaced entries (those with a delete link id) from the input's entries, removes their links
 *    right after it records the staged files, then takes the selection over.
 *  - 02 dist fidelity: the unminified bundle carries the three sites; the minified one carries the
 *    pending selection the take-over reads.
 *  The browser path end to end is test/e2e/validator-upload-zero-removal-b150.spec.js (F1-F3).
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B150_VALIDATOR_SRC=<copy of main.js>, B150_PLUGIN_DIST=<dir holding js/>.
 *
 * Usage: node --test test/core/validator-upload-replaced-delete-link-b150.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

var MAIN     = process.env.B150_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B150_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

// #B960 — the success reads the replaced entries and takes the selection over; the record is gone
// was: var STASH   = '$el._replacedStoredFiles = ( $el._replacedStoredFiles || [] ).concat(_replacedStoredFiles);';
// was: var REPLACE = '$el.customFiles = Array.from(files);';
// was: var LOOKUP  = 'var $replacedLink = document.getElementById($uploadTriger._replacedStoredFiles[r].deleteLinkId);';
// was: var CLEAR   = '$uploadTriger._replacedStoredFiles = [];';
var REPLACED = 'var replacedStoredFiles = ( $uploadTriger.customFiles || [] ).filter(function (entry) { return entry && entry.deleteLinkId; });';
var STAGED   = '$uploadTriger.stagedFiles = files;';
var LOOKUP   = 'var $replacedLink = document.getElementById(replacedStoredFiles[r].deleteLinkId);';
var TAKEOVER = '$uploadTriger.customFiles = $uploadTriger.pendingFiles || [];';

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

describe('#B150 - the delete link of a stored file a selection replaces', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('01 - source pins (comment-stripped)', function () {
        it('the staging success reads the replaced stored entries from the input\'s entries, before it takes the selection over', function () {
            assert.equal(count(code, REPLACED), 1, 'the replaced entries read');
            assert.equal(count(code, TAKEOVER), 1, 'the take-over');
            assert.ok(code.indexOf(REPLACED) < code.indexOf(TAKEOVER), 'the read comes first');
            assert.equal(count(code, "return entry && entry.deleteLinkId; });"), 1, 'only entries that carry a delete link id are read');
            assert.equal(count(code, '_replacedStoredFiles'), 0, 'no record is kept on the input');
        });

        it('the staging success removes the links of the replaced entries right after it records the staged files, then takes the selection over', function () {
            assert.equal(count(code, STAGED), 1);
            assert.equal(count(code, LOOKUP), 1, 'the link lookup');
            var staged = code.indexOf(STAGED), replaced = code.indexOf(REPLACED), lookup = code.indexOf(LOOKUP), takeover = code.indexOf(TAKEOVER);
            assert.ok(staged < replaced && replaced < lookup && lookup < takeover, 'record, read, remove, take over — in that order');
            assert.ok(takeover - staged < 2400, 'the removal sits with the record, not elsewhere in the file (' + (takeover - staged) + ' chars)');
            assert.equal(count(code.slice(lookup, takeover), 'dropEmptyUploadPreviewItem($replacedItem, $previewContainer);'), 1, 'an emptied <li> of the container goes with the link');
        });

        it('[instrument] the raw source carries the lines the stripped reads count', function () {
            assert.ok(count(src, REPLACED) >= 1 && count(src, LOOKUP) >= 1 && count(src, TAKEOVER) >= 1, 'the stripped reads above are not vacuous');
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
        it('the unminified bundle carries the three sites', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assert.equal(count(raw, REPLACED), 1);
            assert.equal(count(raw, LOOKUP), 1);
            assert.equal(count(raw, TAKEOVER), 1);
        });

        it('the minified bundle carries the pending selection the take-over reads', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.ok(count(min, 'pendingFiles') >= 4, 'the write, the two drops and the take-over survive minification (' + count(min, 'pendingFiles') + ')');
        });
    });
});
