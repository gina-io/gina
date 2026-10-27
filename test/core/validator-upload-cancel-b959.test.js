'use strict';
/**
 * FormValidator - a file input change that carries no file leaves the input's records (#B959)
 *
 * The file input's `change` listener records the selection on the input (`customFiles`, the entries
 * its reset and delete links act on) and, since #B150, keeps the stored entries a selection replaces
 * (`_replacedStoredFiles`). A change that carries no file (an emptied selection) wrote both before
 * the listener's early return, so the entries were emptied and every reset or delete link of the
 * input was left bound to nothing: a click sent no request, removed nothing and logged the
 * zero-match warning, while the files' previews and hidden fields stayed in the form. Since the fix
 * the early return comes first. Since #B960 the listener writes neither record: it keeps the
 * selection as `pendingFiles`, which the staging success takes over, so the pins below follow that
 * one write.
 *
 * Strategy:
 *  - 01 source pins on the shipped `main.js`, comment-stripped: in the change listener the early
 *    return follows the file-list read and precedes the listener's only write (the pending
 *    selection), with no write in between, and the listener writes no entry.
 *  - 02 dist fidelity: the unminified bundle carries the same order; in the minified bundle the
 *    listener's early return precedes its pending write.
 *  The browser path end to end is test/e2e/validator-upload-zero-removal-b150.spec.js (F4, F5).
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B959_VALIDATOR_SRC=<copy of main.js>, B959_PLUGIN_DIST=<dir holding js/>.
 *
 * Usage: node --test test/core/validator-upload-cancel-b959.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

var MAIN     = process.env.B959_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B959_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var READ    = 'var files = $el.files;';
var RETURN  = 'if (!files.length ) return false;';
// #B960 — the listener's only write: the selection waits as `pendingFiles` until its staging settles
// was: var STASH   = '$el._replacedStoredFiles = ( $el._replacedStoredFiles || [] ).concat(_replacedStoredFiles);';
// was: var REPLACE = '$el.customFiles = Array.from(files);';
var PENDING = '$el.pendingFiles = Array.from(files);';

// the minified listener: its pending write, and the early return Closure emits
// was: var MIN_READ   = '.customFiles||[]).filter(';
var MIN_PENDING = '.pendingFiles=Array.from(';
var MIN_RETURN  = '.length)return!1;';
var MIN_OPEN    = "'change',function(";

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
 * Asserts the listener's order in a text: the file-list read, the early return, then the pending
 * selection (#B960: the listener's only write), and no entry written by the listener. Each line must
 * occur once, so a copy in a comment fails loudly.
 *
 * @inner
 * @param {string} code - the text to read
 * @param {string} label - names the text in the messages
 * @returns {{read: number, ret: number}} the offsets of the read and of the return
 */
function assertOrder(code, label) {
    assert.equal(count(code, READ), 1, label + ': the file-list read');
    assert.equal(count(code, RETURN), 1, label + ': the early return');
    assert.equal(count(code, PENDING), 1, label + ': the pending selection');
    assert.equal(count(code, '$el.customFiles ='), 0, label + ': the listener writes no entry');
    var read = code.indexOf(READ), ret = code.indexOf(RETURN), pending = code.indexOf(PENDING);
    assert.ok(read < ret, label + ': the return follows the file-list read');
    assert.ok(ret < pending, label + ': the return precedes the pending selection');
    return { read: read, ret: ret };
}

describe('#B959 - a file input change that carries no file leaves the input\'s records', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);

    describe('01 - source pins (comment-stripped)', function () {
        it('the change listener returns on an empty file list before it writes anything', function () {
            var at = assertOrder(code, 'src');
            var before = code.slice(at.read, at.ret);
            assert.equal(count(before, 'customFiles'), 0, 'no customFiles write before the return');
            assert.equal(count(before, 'pendingFiles'), 0, 'no pending selection before the return');
        });

        it('[instrument] the raw source carries the lines the stripped read counts', function () {
            assert.ok(count(src, RETURN) >= 1 && count(src, READ) >= 1 && count(src, PENDING) >= 1, 'the stripped reads above are not vacuous');
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
        it('the unminified bundle carries the same order', function () {
            assertOrder(stripComments(fs.readFileSync(DIST_RAW, 'utf8')), 'gina.js');
        });

        it('in the minified bundle the listener returns on an empty file list before its pending write', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal(count(min, MIN_PENDING), 1, 'the listener\'s pending write');
            var write = min.indexOf(MIN_PENDING);
            var open = min.lastIndexOf(MIN_OPEN, write);
            assert.ok(open > -1 && write - open < 200, 'the write sits at the start of a change listener (' + (write - open) + ' chars)');
            assert.equal(count(min.slice(open, write), MIN_RETURN), 1, 'the early return comes before the write');
        });
    });
});
