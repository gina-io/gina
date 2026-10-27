'use strict';
/**
 * #B965 — a URL placeholder named with digits only stays out of a top-level JSON array body, on every request.
 *
 * Since #B953 a top-level JSON array body is the method's bag (`req.post` / `req.patch`, the same object as
 * `req.body`) on every request. On a warm route-cache hit that bag is the array the request arrived with,
 * and lib/routing's fill (`fitsWithRequirements` writes a URL value where the bag has none of that name)
 * made a placeholder named with digits only an element past the array's end: rule `/r/:grp/:5`, body
 * `[{"a":"1"},2]` — the first request saw the array at length 2, every later one at length 6 with 3 holes
 * and the URL value as element 5. Since 0.7.6 a block after the #B953 one cuts the array back to its arrival
 * length (`_bagArray.length`), so that value stays in `req.params`, as on a first request.
 *
 * §01 pins the block on the comment-stripped source, after the #B953 block and before the #B954 one; §02
 * lifts it out of the SHIPPED source and executes it (its free identifiers are `matched`, `req`,
 * `_bagArray` and `_reqMethodKey`). The booted twin is
 * test/integration/container-boot-array-bag-b965.test.js. Red-first: GINA_SERVER_SRC=<pre-fix server.js>
 * reds every test (the block is absent, so its extraction control fails).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core', 'server.js');
var SERVER = fs.readFileSync(SOURCE, 'utf8');

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
 * literals, so a `was:` line or a comment naming a pinned expression cannot satisfy a pin (copied
 * from test/core/validator-upload-commit-at-success-b960.test.js, which explains the regex case).
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

var SERVER_ST = stripComments(SERVER);

var B953_OPEN = 'if ( matched && _bagArray !== null && !Array.isArray(req[_reqMethodKey]) ) {';
var OPEN      = 'if ( matched && _bagArray !== null && Array.isArray(req[_reqMethodKey]) && req[_reqMethodKey].length > _bagArray.length ) {';
var CUT       = 'req[_reqMethodKey].length = _bagArray.length;';
var B954_OPEN = "if ( matched && typeof(req.params) == 'object' && req.params !== null ) {";

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * A block as it ships: from its opening line to the brace that closes it, in the stripped source.
 *
 * @inner
 * @param {string} open - the block's opening line, which must occur once
 * @returns {string} the block's source text
 */
function liftBlock(open) {
    assert.equal(count(SERVER_ST, open), 1, 'extraction control: the block opens once');
    var at = SERVER_ST.indexOf(open);
    var depth = 0, i = at + open.length - 1;
    for (; i < SERVER_ST.length; i++) {
        if (SERVER_ST[i] === '{') { depth++; }
        else if (SERVER_ST[i] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, 'extraction control: the block closes');
    return SERVER_ST.slice(at, i + 1);
}

/**
 * Runs the shipped #B965 block.
 *
 * @inner
 * @param {boolean} matched - whether a rule matched
 * @param {object} req - the request as it reaches the block
 * @param {Array|null} bagArray - `_bagArray`, the copy of the array captured before the warm lookup
 * @param {string} reqMethodKey - `_reqMethodKey`, the request method before the loop, lower case
 * @returns {object} The same request
 */
function runBlock(matched, req, bagArray, reqMethodKey) {
    new Function('matched', 'req', '_bagArray', '_reqMethodKey', "'use strict';\n" + liftBlock(OPEN))(matched, req, bagArray, reqMethodKey);
    return req;
}

/**
 * The live array as a warm route-cache hit leaves it: the parsed body, the named key the router set, and
 * the URL value of a digits-only placeholder written past its end.
 *
 * @inner
 * @param {Array} arr - the parsed array
 * @param {object} named - the named keys (URL placeholders) the router set
 * @param {object} [indexed] - the digits-only placeholders the router wrote
 * @returns {Array} the same array, grown
 */
function warmArray(arr, named, indexed) {
    Object.keys(named).forEach(function (k) { arr[k] = named[k]; });
    Object.keys(indexed || {}).forEach(function (k) { arr[k] = indexed[k]; });
    return arr;
}

function holes(arr) { var n = 0; for (var i = 0; i < arr.length; i++) { if (!Object.prototype.hasOwnProperty.call(arr, i)) { n++; } } return n; }


// ---------------------------------------------------------------------------
describe('request-array-bag-b965 §01 — the block in _handleDispatch', function () {

    it('01.1  the block exists once, and it cuts the array to its arrival length', function () {
        var block = liftBlock(OPEN);
        assert.equal(count(block, CUT), 1, 'the cut');
    });

    it('01.2  it follows the #B953 block and precedes the #B954 one', function () {
        assert.equal(count(SERVER_ST, B953_OPEN), 1, 'control: the #B953 block is found once');
        assert.equal(count(SERVER_ST, B954_OPEN), 1, 'control: the #B954 block is found once');
        var b953 = SERVER_ST.indexOf(B953_OPEN), here = SERVER_ST.indexOf(OPEN), b954 = SERVER_ST.indexOf(B954_OPEN);
        assert.ok(here > -1 && b953 < here && here < b954, 'order: #B953 ' + b953 + ' < #B965 ' + here + ' < #B954 ' + b954);
    });
});


// ---------------------------------------------------------------------------
describe('request-array-bag-b965 §02 — the shipped block, executed', function () {

    it('02.1  a warm POST: the URL value written as element 5 goes, the array keeps its identity, its elements and its named key', function () {
        var arr = [{ a: '1' }, 2], bagArray = arr.slice();
        warmArray(arr, { grp: 'g1' }, { 5: 'x' });
        assert.equal(arr.length, 6, 'control: the router\'s write grew the array');
        var req = runBlock(true, { post: arr, body: arr }, bagArray, 'post');
        assert.equal(req.post, arr, 'the same array');
        assert.equal(req.body, arr, 'req.body still names it');
        assert.equal(arr.length, 2, 'its arrival length');
        assert.equal(holes(arr), 0, 'no holes');
        assert.deepEqual(Object.keys(arr), ['0', '1', 'grp']);
        assert.deepEqual(arr[0], { a: '1' });
        assert.equal(arr[1], 2);
        assert.equal(arr.grp, 'g1', 'the named placeholder stays');
    });

    it('02.2  a warm PATCH: the same', function () {
        var arr = [{ a: '1' }, 2], bagArray = arr.slice();
        warmArray(arr, { grp: 'g1' }, { 5: 'x' });
        var req = runBlock(true, { patch: arr, body: arr }, bagArray, 'patch');
        assert.equal(req.patch, arr);
        assert.equal(arr.length, 2);
        assert.deepEqual(Object.keys(arr), ['0', '1', 'grp']);
    });

    it('02.3  control: an index inside the array (`:1`) wrote nothing, so the array is left as it is', function () {
        var arr = [{ a: '1' }, 2], bagArray = arr.slice();
        warmArray(arr, { grp: 'g1' });
        var req = runBlock(true, { post: arr, body: arr }, bagArray, 'post');
        assert.equal(req.post, arr);
        assert.equal(arr.length, 2);
        assert.deepEqual(Object.keys(arr), ['0', '1', 'grp']);
    });

    it('02.4  control: a cold match left `_bagArray` itself, already at its arrival length: left as it is', function () {
        var bagArray = [{ a: '1' }, 2];
        bagArray.grp = 'g1';
        var req = runBlock(true, { post: bagArray, body: bagArray }, bagArray, 'post');
        assert.equal(req.post, bagArray);
        assert.equal(bagArray.length, 2);
        assert.deepEqual(Object.keys(bagArray), ['0', '1', 'grp']);
    });

    it('02.5  control: no rule matched, so the block leaves even a grown array alone', function () {
        var arr = [{ a: '1' }, 2], bagArray = arr.slice();
        warmArray(arr, {}, { 5: 'x' });
        runBlock(false, { post: arr, body: arr }, bagArray, 'post');
        assert.equal(arr.length, 6);
    });

    it('02.6  control: an object body (no array captured) keeps its digits-only key', function () {
        var bag = { a: '1', id: '99', 5: 'x' };
        var req = runBlock(true, { post: bag, body: bag }, null, 'post');
        assert.equal(req.post, bag);
        assert.equal(bag['5'], 'x');
    });
});
