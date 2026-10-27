'use strict';
/**
 * #B953 — a top-level JSON array body reaches the action as the array, on every request.
 *
 * processRequestData parses a `[`-leading POST or PATCH body into an array and makes it the method's
 * bag (`req.post` / `req.patch`, the same object as `req.body`). The routing loop in `_handleDispatch`
 * (core/server.js) matches on an `Object.assign` copy of the bag, which keys an array by index, while a
 * warm route-cache hit breaks out before that copy. The route cache keys the concrete path, so the
 * first request to each path got `{ "0": …, "1": … }` (a separate object from `req.body`) and every
 * later one the array itself; and since the #B954 block skipped an array bag, a `true` / `false` /
 * `on` URL segment was a boolean on the first request only, in `req.params` too.
 *
 * Since 0.7.6 a copy of the array is captured before the warm lookup, and a block after the post-loop
 * restore puts it back once a rule has matched on the loop's copy: the copy's other keys (the URL
 * placeholders the router set) are carried where the array has no property of that name, and
 * `req.body` names the array when it named the bag before routing. The #B954 block then treats an
 * array bag as any other, except under the names the array answers for itself (an index, `length`,
 * one of its methods), whose URL values stay in `req.params`.
 *
 * §01 pins the captures and both blocks on the comment-stripped source; §02 lifts the new block out of
 * the SHIPPED source and executes it (its free identifiers are `matched`, `req`, `_bagArray`,
 * `_bodyIsBagArray` and `_reqMethodKey`); §03 lifts the #B954 block and executes it on an array bag.
 * The booted twin is test/integration/container-boot-array-bag-b953.test.js. Red-first:
 * GINA_SERVER_SRC=<pre-fix server.js> reds §01, §02 and every §03 arm but its object-bag control.
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

var CAPTURE_ARRAY = 'var _bagArray           = Array.isArray(req[_reqMethodKey]) ? req[_reqMethodKey].slice() : null;';
var CAPTURE_BODY  = 'var _bodyIsBagArray     = ( _bagArray !== null && req.body === req[_reqMethodKey] );';
var OPEN          = 'if ( matched && _bagArray !== null && !Array.isArray(req[_reqMethodKey]) ) {';
var LOOKUP        = 'routingLib.getCached(';
// the routing loop's last statement (its `// EO for` closing comment does not survive the strip)
var LOOP_CACHE    = "routingLib.cache(req.method +':'+ pathname, name, routing[name], params, req[method]);";
var RESTORE       = 'if (typeof(req[_reqMethodKey]) == "undefined") {';
var B954_OPEN     = "if ( matched && typeof(req.params) == 'object' && req.params !== null ) {";
var B954_BAG      = "if ( typeof(_paramsBag) == 'object' && _paramsBag !== null ) {";
var B954_SKIPPED  = '!Array.isArray(_paramsBag)';
var ARRAY_OWN     = "if ( _bagIsArray && ( /^[0-9]+$/.test(_pk) || _pk === 'length' || typeof(_paramsBag[_pk]) != 'undefined' && !Object.prototype.hasOwnProperty.call(_paramsBag, _pk) ) ) {";

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
 * Runs the shipped #B953 block.
 *
 * @inner
 * @param {boolean} matched - whether a rule matched
 * @param {object} req - the request as it reaches the block
 * @param {Array|null} bagArray - `_bagArray`, the copy captured before the warm lookup
 * @param {boolean} bodyIsBagArray - `_bodyIsBagArray`, captured beside it
 * @param {string} reqMethodKey - `_reqMethodKey`, the request method before the loop, lower case
 * @returns {object} The same request
 */
function runBlock(matched, req, bagArray, bodyIsBagArray, reqMethodKey) {
    new Function('matched', 'req', '_bagArray', '_bodyIsBagArray', '_reqMethodKey', "'use strict';\n" + liftBlock(OPEN))(matched, req, bagArray, bodyIsBagArray, reqMethodKey);
    return req;
}

/**
 * Runs the shipped #B954 block (its free identifiers: `matched`, `req`, `_bodyIsReqMethod`,
 * `_reqMethodKey`).
 *
 * @inner
 * @param {boolean} matched - whether a rule matched
 * @param {object} req - the request as it reaches the block
 * @param {boolean} bodyIsReqMethod - `_bodyIsReqMethod`, captured before routing
 * @param {string} reqMethodKey - `_reqMethodKey`
 * @returns {object} The same request
 */
function runB954(matched, req, bodyIsReqMethod, reqMethodKey) {
    new Function('matched', 'req', '_bodyIsReqMethod', '_reqMethodKey', "'use strict';\n" + liftBlock(B954_OPEN))(matched, req, bodyIsReqMethod, reqMethodKey);
    return req;
}

/**
 * The bag the routing loop hands over on a first request: the array keyed by index, plus the named
 * keys the router set.
 *
 * @inner
 * @param {Array} arr - the parsed array
 * @param {object} [named] - the named keys (URL placeholders)
 * @returns {object} the index-keyed copy
 */
function keyedCopy(arr, named) { return Object.assign({}, arr, named || {}); }


// ---------------------------------------------------------------------------
describe('request-array-bag-b953 §01 — the captures and the blocks in _handleDispatch', function () {

    it('01.1  the two captures and the block exist once in the live code', function () {
        assert.equal(count(SERVER_ST, CAPTURE_ARRAY), 1, 'the array capture');
        assert.equal(count(SERVER_ST, CAPTURE_BODY), 1, 'the req.body capture');
        liftBlock(OPEN);
    });

    it('01.2  the captures precede the warm route-cache lookup; the block follows the loop and the restore, before the #B954 block', function () {
        assert.equal(count(SERVER_ST, LOOKUP), 1, 'control: the lookup is found once');
        assert.equal(count(SERVER_ST, LOOP_CACHE), 1, 'control: the routing loop\'s last statement is found once');
        assert.equal(count(SERVER_ST, RESTORE), 1, 'control: the restore is found once');
        assert.equal(count(SERVER_ST, B954_OPEN), 1, 'control: the #B954 block is found once');
        var capA = SERVER_ST.indexOf(CAPTURE_ARRAY), capB = SERVER_ST.indexOf(CAPTURE_BODY), lookup = SERVER_ST.indexOf(LOOKUP);
        var loopEnd = SERVER_ST.indexOf(LOOP_CACHE), restore = SERVER_ST.indexOf(RESTORE);
        var block = SERVER_ST.indexOf(OPEN), b954 = SERVER_ST.indexOf(B954_OPEN);
        assert.ok(capA > -1 && capA < capB && capB < lookup, 'the captures run before the warm lookup writes into the bag');
        assert.ok(loopEnd < restore && restore < block, 'the block follows the loop and the restore');
        assert.ok(block < b954, 'the block precedes the #B954 block, which then sees the array');
    });

    it('01.3  the block carries the copy\'s own, non-index keys where the array has no such property, and names req.body only when it was the bag', function () {
        var block = liftBlock(OPEN);
        assert.ok(block.indexOf("Object.prototype.hasOwnProperty.call(_keyedBag, _kk) && !/^[0-9]+$/.test(_kk) && typeof(_bagArray[_kk]) == 'undefined'") > -1);
        assert.ok(block.indexOf('req[_reqMethodKey] = _bagArray;') > -1);
        assert.ok(/if \( _bodyIsBagArray \) \{\s*req\.body = _bagArray;\s*\}/.test(block));
        assert.equal(block.indexOf('.count('), -1, 'no client-shadowable count call');
    });

    it('01.4  the #B954 block takes an array bag, except under the names the array answers for itself', function () {
        var b954 = liftBlock(B954_OPEN);
        assert.equal(b954.indexOf(B954_SKIPPED), -1, 'an array bag is no longer skipped');
        assert.ok(b954.indexOf(B954_BAG) > -1);
        assert.ok(b954.indexOf('var _bagIsArray = Array.isArray(_paramsBag);') > -1);
        assert.ok(b954.indexOf(ARRAY_OWN) > -1);
    });

    it('01.5  CONTROL — the strip is proven: comments above the block are in the raw source and not in the stripped one, and the code survives it', function () {
        assert.ok(SERVER.indexOf('// #B953 — a top-level JSON array body reached the action as an object keyed by index on the') > -1);
        assert.equal(SERVER_ST.indexOf('#B953'), -1);
        assert.ok(SERVER.indexOf("// was: if ( typeof(_paramsBag) == 'object' && _paramsBag !== null && !Array.isArray(_paramsBag) ) {") > -1, 'the replaced line is kept as a comment');
        assert.ok(SERVER_ST.indexOf("var _reqMethodKey   = (method || req.method || 'GET').toLowerCase();") > -1, 'a code line survives the strip');
    });
});


// ---------------------------------------------------------------------------
describe('request-array-bag-b953 §02 — the lifted block, executed', function () {

    it('02.1  first request, no placeholders: the bag is the array again and req.body names it', function () {
        var arr = [{ a: '1' }, 2];
        var req = runBlock(true, { method: 'POST', params: { 0: '/p' }, post: keyedCopy(arr), body: arr }, arr.slice(), true, 'post');
        assert.ok(Array.isArray(req.post));
        assert.deepEqual(req.post, [{ a: '1' }, 2]);
        assert.equal(req.body, req.post);
    });

    it('02.2  first request with placeholders: the router\'s named keys are carried onto the array', function () {
        var arr = [{ a: '1' }, 2];
        var req = runBlock(true, { method: 'PATCH', params: { 0: '/p/g1/42', grp: 'g1', id: '42' }, patch: keyedCopy(arr, { grp: 'g1', id: '42' }), body: arr }, arr.slice(), true, 'patch');
        assert.ok(Array.isArray(req.patch));
        assert.equal(req.patch.length, 2);
        assert.equal(req.patch.grp, 'g1');
        assert.equal(req.patch.id, '42');
        assert.equal(req.body, req.patch);
    });

    it('02.3  names the array answers for itself are not written: length, a method, an index', function () {
        var arr = [{ a: '1' }, 2];
        var req = runBlock(true, { method: 'POST', params: { 0: '/p' }, post: keyedCopy(arr, { length: '5', map: 'world', 7: 'x' }), body: arr }, arr.slice(), true, 'post');
        assert.equal(req.post.length, 2, 'the length is the array\'s');
        assert.equal(typeof(req.post.map), 'function', 'the method is the array\'s');
        assert.equal(Object.prototype.hasOwnProperty.call(req.post, '7'), false, 'no index is added');
        assert.deepEqual(req.post, [{ a: '1' }, 2]);
    });

    it('02.4  a warm request (the bag is still the array): nothing changes', function () {
        var arr = [{ a: '1' }, 2]; arr.id = '42';
        var body = arr;
        var req = runBlock(true, { method: 'POST', params: { 0: '/p', id: '42' }, post: arr, body: body }, [{ a: '1' }, 2], true, 'post');
        assert.equal(req.post, arr, 'the same object');
        assert.equal(req.body, body);
    });

    it('02.5  CONTROL — no rule matched: nothing changes', function () {
        var arr = [{ a: '1' }, 2], bag = keyedCopy(arr);
        var req = runBlock(false, { method: 'POST', params: { 0: '/p' }, post: bag, body: arr }, arr.slice(), true, 'post');
        assert.equal(req.post, bag);
        assert.equal(req.body, arr);
    });

    it('02.6  CONTROL — no array was captured (an object body): nothing changes', function () {
        var bag = { a: '1' };
        var req = runBlock(true, { method: 'POST', params: { 0: '/p' }, post: bag, body: bag }, null, false, 'post');
        assert.equal(req.post, bag);
    });

    it('02.7  req.body was not the bag before routing: the bag is the array, req.body is left alone', function () {
        var arr = [{ a: '1' }, 2], other = { x: 1 };
        var req = runBlock(true, { method: 'POST', params: { 0: '/p' }, post: keyedCopy(arr), body: other }, arr.slice(), false, 'post');
        assert.ok(Array.isArray(req.post));
        assert.equal(req.body, other);
    });

    it('02.8  a rejected warm candidate wrote onto the live array: the bag is the copy captured before, without that write', function () {
        var arr = [{ a: '1' }, 2], snapshot = arr.slice();
        arr.stale = 'x';
        var req = runBlock(true, { method: 'POST', params: { 0: '/p', id: '7' }, post: keyedCopy(snapshot, { id: '7' }), body: arr }, snapshot, true, 'post');
        assert.equal(Object.prototype.hasOwnProperty.call(req.post, 'stale'), false);
        assert.equal(req.post.id, '7');
        assert.equal(req.body, req.post);
    });
});


// ---------------------------------------------------------------------------
describe('request-array-bag-b953 §03 — the #B954 block on an array bag', function () {

    it('03.1  the URL values land on the array, with the coercion, in the bag and in req.params', function () {
        var arr = [{ a: '1' }, 2];
        var req = runB954(true, { method: 'POST', params: { 0: '/p/g1/true', grp: 'g1', id: 'true' }, post: arr, body: arr }, false, 'post');
        assert.equal(req.post.grp, 'g1');
        assert.equal(req.post.id, true);
        assert.equal(req.params.id, true);
        assert.equal(req.post.length, 2);
        assert.deepEqual(Array.from(req.post), [{ a: '1' }, 2]);
    });

    it('03.2  a value the router already set on the array is replaced by the coerced URL value', function () {
        var arr = [{ a: '1' }, 2]; arr.id = 'on';
        var req = runB954(true, { method: 'PATCH', params: { 0: '/p/g1/on', id: 'on' }, patch: arr, body: arr }, false, 'patch');
        assert.equal(req.patch.id, true);
    });

    it('03.3  names the array answers for itself stay in req.params only: an index, length, a method; an ordinary name lands', function () {
        var arr = [{ a: '1' }, 2];
        var req = runB954(true, { method: 'POST', params: { 0: '/p', grp: 'g1', 1: 'one', length: '5', map: 'world' }, post: arr, body: arr }, false, 'post');
        assert.equal(req.post.grp, 'g1', 'an ordinary placeholder lands on the array');
        assert.equal(req.post.length, 2);
        assert.equal(typeof(req.post.map), 'function');
        assert.equal(req.post[1], 2, 'the element at index 1 is the body\'s');
        assert.equal(req.params.length, '5');
        assert.equal(req.params.map, 'world');
    });

    it('03.4  CONTROL — an object bag: the URL value wins over a same-name body key, as before', function () {
        var bag = { id: '99', x: '1' };
        var req = runB954(true, { method: 'POST', params: { 0: '/p/42', id: '42' }, post: bag, body: bag }, true, 'post');
        assert.deepEqual(req.post, { id: '42', x: '1' });
    });
});
