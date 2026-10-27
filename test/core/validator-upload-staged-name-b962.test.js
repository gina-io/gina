'use strict';
/**
 * FormValidator - a successful staging fills the `[name]` field from its answer, like every other key (#B962)
 *
 * The staging success fills the form's hidden fields from the answer, one key at a time, and skipped
 * `name` whenever its field already held a value. So a replacement in an edit form, whose `[name]` the
 * page declares with the saved file's name, posted that name beside the new file's location and
 * original filename, and a second selection on the same input posted the first staged file's name. The
 * uploads guide says the staged file takes the replaced file's fields. Since the fix the answer's
 * `name` fills the field like every other key; an answer that carries no `name` (the answer the guide
 * documents) leaves the field as it is.
 *
 * Strategy:
 *  - 01 behaviour: the real `for (var key in fieldsObjectList)` fill loop, brace-walked out of the
 *    shipped `main.js` (comment- and string-aware), runs against jsdom fields: an edit form's declared
 *    name and a first staging's name each give way to the next answer's; an answer without `name`
 *    leaves a declared name, and an empty field is filled (the controls).
 *  - 02 source pins, comment-stripped: the fill loop's skip condition no longer names `name`.
 *  - 03 dist fidelity: the unminified bundle carries the same condition; in the minified bundle, the
 *    skip condition (from the fill's read of the field map to its height and width clause) no longer
 *    compares a key with `'name'`.
 *  The browser path end to end is test/e2e/validator-upload-staged-name-b962.spec.js.
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B962_VALIDATOR_SRC=<copy of main.js>, B962_PLUGIN_DIST=<dir holding js/>.
 *
 * Usage: node --test test/core/validator-upload-staged-name-b962.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var { JSDOM } = require('jsdom');

var FW = require('../fw');

var MAIN     = process.env.B962_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B962_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

var FILL_HEAD    = 'for (var key in fieldsObjectList) {';
var RETIRED      = "key == 'name'";
var PREVIEW_SKIP = "key == 'preview' && typeof(files[f][key]) == 'undefined'";
// the skip condition as it reads since the fix: the answer's missing key comes first
var SKIP_HEAD    = /if\s*\(\s*!files\[f\]\[key\]\s*\|\|\s*key == 'preview' && typeof\(files\[f\]\[key\]\) == 'undefined'/;

// the minified fill, as Closure emits it: the field map read, then the height and width clause
var MIN_FILL     = '.uploadFields[';
var MIN_SIZE     = '/(height|width)/i.test(';

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
 * literal is copied as it is.
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
 * The fill loop of a source, from its head to its closing brace, walked over comments and string
 * literals so a brace inside either cannot unbalance the walk.
 *
 * @inner
 * @param {string} src - the source
 * @param {string} label - names the source in the messages
 * @returns {string} the loop's text
 */
function fillLoopText(src, label) {
    assert.equal(count(src, FILL_HEAD), 1, label + ': the fill loop head');
    var at = src.indexOf(FILL_HEAD);
    var open = src.indexOf('{', at), depth = 0, i = open;
    var inLine = false, inBlock = false, inStr = false, strCh = '';
    for (; i < src.length; i++) {
        var c = src[i], n = src[i + 1];
        if (inLine) { if (c === '\n') { inLine = false; } continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (inStr) { if (c === '\\') { i++; continue; } if (c === strCh) { inStr = false; } continue; }
        if (c === '/' && n === '/') { inLine = true; i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
        if (c === '{') { depth++; }
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, label + ': unbalanced braces walking the fill loop');
    return src.substring(at, i);
}

/**
 * The fill loop's skip condition: from the loop head to the first `continue;` after it.
 *
 * @inner
 * @param {string} loop - the loop's text, comment-stripped
 * @param {string} label - names the source in the messages
 * @returns {string} the text of the condition and its branch
 */
function skipText(loop, label) {
    var end = loop.indexOf('continue;');
    assert.ok(end > -1, label + ': the skip branch');
    return loop.slice(0, end);
}

/**
 * Builds hidden inputs in a fresh jsdom form and maps them by key, as `buildUploadHiddenFields`
 * hands them to the fill loop.
 *
 * @inner
 * @param {object} values - the field values by key (`name`, `location`, `originalFilename`)
 * @returns {{doc: Document, map: object}} the document and the field map
 */
function scene(values) {
    var dom = new JSDOM('<!doctype html><body><form id="f"><input type="file" id="docA" name="doc"></form></body>');
    var doc = dom.window.document, form = doc.getElementById('f');
    var map = {};
    Object.keys(values).forEach(function (key) {
        var el = doc.createElement('input');
        el.type = 'hidden'; el.id = 'doc0' + key; el.name = 'doc[0][' + key + ']'; el.value = values[key];
        form.appendChild(el);
        map[key] = el;
    });
    return { doc: doc, map: map };
}

/**
 * One staging answer for a file, with or without its `name` key.
 *
 * @inner
 * @param {string} file - the chosen file's name
 * @param {boolean} [withName=true] - false leaves `name` out, as the answer the guide documents
 * @returns {object} the answer's entry
 */
function answer(file, withName) {
    var a = { location: '/tmp/uploads/staged-' + file, originalFilename: file, mime: 'image/png' };
    if (withName !== false) { a.name = 'staged-' + file; }
    return a;
}

describe('#B962 - a successful staging fills the [name] field from its answer', function () {
    var src  = fs.readFileSync(MAIN, 'utf8');
    var code = stripComments(src);
    var runFill;

    before(function () {
        var loop = fillLoopText(src, 'src');
        runFill = new Function('fieldsObjectList', 'files', 'f', 'document', 'uploadProperties', '$previewContainer', 'fadeIn',
            'var $elIgnored = null;\n' + loop + '\n');
    });

    function fill(s, entry) {
        runFill(s.map, [entry], 0, s.doc, { hasPreviewContainer: false }, null, function () {});
    }

    describe('01 - the real fill loop on jsdom fields', function () {
        it('an edit form: the saved file\'s declared name gives way to the staged file\'s', function () {
            var s = scene({ name: 'old.png', location: '/media/stored/old.png', originalFilename: '' });
            fill(s, answer('new.png'));
            assert.equal(s.map.location.value, '/tmp/uploads/staged-new.png', 'the location is the staged file\'s');
            assert.equal(s.map.originalFilename.value, 'new.png', 'the original filename is the staged file\'s');
            assert.equal(s.map.name.value, 'staged-new.png', 'the name is the staged file\'s');
        });

        it('a second staging on the same fields: the first staged file\'s name gives way to the second\'s', function () {
            var s = scene({ name: '', location: '', originalFilename: '' });
            fill(s, answer('a.png'));
            assert.equal(s.map.name.value, 'staged-a.png', 'the first staging fills the empty field');
            fill(s, answer('b.png'));
            assert.equal(s.map.location.value, '/tmp/uploads/staged-b.png', 'the location is the second file\'s');
            assert.equal(s.map.name.value, 'staged-b.png', 'the name is the second file\'s');
        });

        it('control: an answer without a name leaves the declared name as it is', function () {
            var s = scene({ name: 'old.png', location: '/media/stored/old.png', originalFilename: '' });
            fill(s, answer('new.png', false));
            assert.equal(s.map.location.value, '/tmp/uploads/staged-new.png', 'the staging filled the location');
            assert.equal(s.map.name.value, 'old.png', 'no answer key, no write');
        });

        it('control: an empty name field is filled from the answer', function () {
            var s = scene({ name: '', location: '' });
            fill(s, answer('a.png'));
            assert.equal(s.map.name.value, 'staged-a.png');
            assert.equal(s.map.location.value, '/tmp/uploads/staged-a.png');
        });
    });

    describe('02 - source pins (comment-stripped)', function () {
        it('the fill loop skips a key only when the answer lacks it, or for the preview, height and width rules', function () {
            var skip = skipText(fillLoopText(code, 'src'), 'src');
            assert.equal(count(skip, RETIRED), 0, 'the skip condition no longer names the name key');
            assert.match(skip, SKIP_HEAD, 'the missing answer key is the first clause, followed by the preview rule');
        });

        it('[instrument] the raw source still names the retired clause, which the stripper removes', function () {
            assert.equal(count(skipText(fillLoopText(src, 'raw src'), 'raw src'), RETIRED), 1, 'the raw skip text holds the needle (in a was: line since the fix)');
            assert.equal(count(code, PREVIEW_SKIP), 1, 'the stripped source holds the condition the pin anchors on');
            assert.ok(count(src, '// was:') > 0, 'the raw source holds was: lines');
            assert.equal(count(code, '// was:'), 0, 'no was: line survives the stripper');
        });
    });

    describe('03 - dist fidelity', function () {
        it('the unminified bundle carries the same skip condition', function () {
            var raw  = fs.readFileSync(DIST_RAW, 'utf8');
            var skip = skipText(fillLoopText(stripComments(raw), 'gina.js'), 'gina.js');
            assert.equal(count(skip, RETIRED), 0, 'gina.js: the skip condition no longer names the name key');
            assert.match(skip, SKIP_HEAD, 'gina.js: the missing answer key comes first');
        });

        it('the minified bundle\'s skip condition compares no key with \'name\'', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal(count(min, MIN_FILL), 1, 'the fill reads the field map once');
            var at = min.indexOf(MIN_FILL), end = min.indexOf(MIN_SIZE, at);
            assert.ok(end > at && end - at < 300, 'the window between the map read and the height and width clause');
            var cond = min.slice(at, end);
            assert.equal(count(cond, "=='preview'"), 1, 'the window holds the preview rule');
            assert.equal(count(cond, "=='name'"), 0, 'no key is compared with name');
        });
    });
});
