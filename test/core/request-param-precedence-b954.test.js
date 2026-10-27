'use strict';
/**
 * #B954 / #B957 — once a rule has matched, a URL placeholder's value wins over a query or body key
 * of the same name, on the first request to a METHOD:PATH and on every later one.
 *
 * The routing loop in `_handleDispatch` (core/server.js) copies `req.params` over the method's bag
 * only on a cold match (GET and DELETE only when the query is empty), `lib/routing` fills the bag
 * only where the client sent no key of that name, and the warm route-cache path breaks out of the
 * loop before either copy. A block after the post-loop restore now copies every own key of
 * `req.params` but the engine's `0` over `req[req.method]`, with the loop's coercion of 'false' /
 * 'true' / 'on', and points `req.body` back at the bag when it was the bag before routing.
 *
 * §01 pins the block and its placement on the comment-stripped source; §02 lifts the block out of
 * the SHIPPED source and executes it (its free identifiers are `matched`, `req`, `_bodyIsReqMethod`
 * and `_reqMethodKey`). The booted twin is
 * test/integration/container-boot-param-precedence-b954.test.js. Red-first:
 * GINA_SERVER_SRC=<pre-fix server.js> reds §01 and every §02 arm that runs the lifted block.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core', 'server.js');
var SERVER = fs.readFileSync(SOURCE, 'utf8');

// Whole-line `//` comments FIRST, then block comments: a `/*` inside a `// …` line
// would otherwise open a phantom block comment that swallows the code after it.
function stripComments(src) {
    return src
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}
var SERVER_ST = stripComments(SERVER);

var OPEN     = "if ( matched && typeof(req.params) == 'object' && req.params !== null ) {";
var CAPTURE  = "var _bodyIsReqMethod    = ( typeof(req.body) == 'object' && req.body !== null && !Array.isArray(req.body) && req.body === req[_reqMethodKey] );";
var REALIAS  = 'req.body = req[_reqMethodKey];';
var LOOKUP   = 'routingLib.getCached(';
var LOOP_END = '} // EO for (let name in routing) {';
var RESTORE  = 'if (typeof(req[_reqMethodKey]) == "undefined") {';
var MATCHED  = 'if (matched) {';
var IN_LOOP  = 'for (let parameter in req.params) {';

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The block as it ships: from its opening line to the brace that closes it.
 *
 * @returns {string} The block's source text
 */
function liftBlock() {
    var at = SERVER_ST.indexOf(OPEN);
    assert.ok(at > -1, 'extraction control: the block exists in the source');
    var depth = 0, i = at + OPEN.length - 1;
    for (; i < SERVER_ST.length; i++) {
        if (SERVER_ST[i] === '{') { depth++; }
        else if (SERVER_ST[i] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, 'extraction control: the block closes');
    var block = SERVER_ST.slice(at, i + 1);
    assert.ok(block.indexOf(REALIAS) > -1, 'extraction control: the lifted block holds the req.body re-alias');
    return block;
}

/**
 * Runs the shipped block.
 *
 * @param {boolean} matched - whether a rule matched
 * @param {object} req - the request as it reaches the block
 * @param {boolean} bodyIsReqMethod - `_bodyIsReqMethod`, captured before routing
 * @param {string} reqMethodKey - `_reqMethodKey`, the request method before the loop, lower case
 * @returns {object} The same request
 */
function runBlock(matched, req, bodyIsReqMethod, reqMethodKey) {
    new Function('matched', 'req', '_bodyIsReqMethod', '_reqMethodKey', "'use strict';\n" + liftBlock())(matched, req, bodyIsReqMethod, reqMethodKey);
    return req;
}


// ---------------------------------------------------------------------------
describe('request-param-precedence-b954 §01 — the block in _handleDispatch', function () {

    it('01.1  the block and the req.body capture exist once in the live code', function () {
        assert.equal(count(SERVER_ST, OPEN), 1, 'one block');
        assert.equal(count(SERVER_ST, CAPTURE), 1, 'one capture');
        liftBlock();
    });

    it('01.2  the capture precedes the warm route-cache lookup; the block follows the loop and the restore, before the dispatch branch', function () {
        assert.equal(count(SERVER_ST, LOOKUP), 1, 'control: the lookup is found once');
        assert.equal(count(SERVER_ST, LOOP_END), 1, 'control: the routing loop end is found once');
        assert.equal(count(SERVER_ST, RESTORE), 1, 'control: the restore is found once');
        assert.equal(count(SERVER_ST, MATCHED), 1, 'control: the dispatch branch is found once');
        var capture = SERVER_ST.indexOf(CAPTURE), lookup = SERVER_ST.indexOf(LOOKUP);
        var loopEnd = SERVER_ST.indexOf(LOOP_END), restore = SERVER_ST.indexOf(RESTORE);
        var block = SERVER_ST.indexOf(OPEN), dispatch = SERVER_ST.indexOf(MATCHED);
        assert.ok(capture < lookup, 'the capture runs before the warm lookup fills or replaces the bag');
        assert.ok(loopEnd < restore && restore < block, 'the block follows the loop and the restore');
        assert.ok(block < dispatch, 'the block precedes the dispatch branch (whose first statement stays the #B675 alias)');
    });

    it('01.3  the four copy blocks inside the loop are still there', function () {
        assert.equal(count(SERVER_ST, IN_LOOP), 4);
    });

    it('01.4  the block reads own keys without the client-shadowable count helpers', function () {
        var block = liftBlock();
        assert.equal(block.indexOf('ownCount('), -1);
        assert.equal(block.indexOf('.count('), -1);
        assert.ok(block.indexOf('Object.prototype.hasOwnProperty.call(req.params, _pk)') > -1);
    });

    it('01.5  CONTROL — the strip is proven: the comment above the block is in the raw source and not in the stripped one', function () {
        assert.ok(SERVER.indexOf('// #B954 / #B957 — once a rule has matched') > -1);
        assert.equal(SERVER_ST.indexOf('#B954'), -1);
    });

    it('01.6  an array body is left out of the capture, so req.body keeps the array (#B594; the loop re-keys the bag, #B953)', function () {
        assert.ok(CAPTURE.indexOf('!Array.isArray(req.body)') > -1, 'control: the needle names the exclusion');
        assert.equal(count(SERVER_ST, CAPTURE), 1);
    });
});


// ---------------------------------------------------------------------------
describe('request-param-precedence-b954 §02 — the lifted block, executed', function () {

    it('02.1  GET: the URL value replaces a same-name query value; the engine seed `0` is not copied', function () {
        var req = runBlock(true, { method: 'GET', params: { 0: '/p/g2/43', grp: 'g2', id: '43' }, get: { id: '99', x: 1 }, body: {} }, false, 'get');
        assert.deepEqual(req.get, { id: '43', x: 1, grp: 'g2' });
        assert.equal(Object.prototype.hasOwnProperty.call(req.get, '0'), false);
    });

    it('02.2  "true" and "on" become true, "false" becomes false, in req.params and in the bag; other values are left as they are', function () {
        var req = runBlock(true, { method: 'PUT', params: { 0: '/p', a: 'true', b: 'on', c: 'false', d: 'other', e: 7, f: 'null' }, put: {}, body: {} }, false, 'put');
        assert.deepEqual(req.params, { 0: '/p', a: true, b: true, c: false, d: 'other', e: 7, f: 'null' });
        assert.deepEqual(req.put, { a: true, b: true, c: false, d: 'other', e: 7, f: 'null' });
    });

    it('02.3  an inherited key of req.params is not copied; an own key named hasOwnProperty is, without throwing', function () {
        var params = Object.create({ inherited: 'x' });
        params[0] = '/p'; params.id = '43'; params.hasOwnProperty = 'own';
        var req = runBlock(true, { method: 'POST', params: params, post: { id: '99' }, body: {} }, false, 'post');
        assert.deepEqual(req.post, { id: '43', hasOwnProperty: 'own' });
    });

    it('02.4  GET→DELETE override: the bag is req.delete; req.get is left alone', function () {
        var get = { id: '99' };
        var req = runBlock(true, { method: 'DELETE', params: { 0: '/p', id: '43' }, get: get, delete: { id: '99' }, body: {} }, false, 'get');
        assert.deepEqual(req.delete, { id: '43' });
        assert.deepEqual(get, { id: '99' });
    });

    it('02.5  HEAD: the bag is req.head', function () {
        var req = runBlock(true, { method: 'HEAD', params: { 0: '/p', id: '43' }, head: { id: '99' }, body: {} }, false, 'head');
        assert.deepEqual(req.head, { id: '43' });
    });

    it('02.6  req.body was the bag before routing: it is the bag again, holding the URL value', function () {
        var original = { id: '99', x: '1' };
        var bag = Object.assign({}, original);
        var req = runBlock(true, { method: 'PUT', params: { 0: '/p', id: '43' }, put: bag, body: original }, true, 'put');
        assert.equal(req.body, bag, 'the same object as req.put');
        assert.equal(req.body.id, '43');
        assert.deepEqual(original, { id: '99', x: '1' }, 'the object req.body named before is left as it was');
    });

    it('02.7  req.body was not the bag before routing: it is left alone', function () {
        var body = '';
        var req = runBlock(true, { method: 'POST', params: { 0: '/p', id: '43' }, post: {}, body: body }, false, 'post');
        assert.equal(req.body, '');
        assert.deepEqual(req.post, { id: '43' });
    });

    it('02.8  CONTROL — no rule matched: nothing changes', function () {
        var original = { id: '99' };
        var bag = { id: '99' };
        var req = runBlock(false, { method: 'PUT', params: { 0: '/p', id: '43' }, put: bag, body: original }, true, 'put');
        assert.deepEqual(req.put, { id: '99' });
        assert.equal(req.body, original);
    });

    it('02.9  an array bag takes the URL values beside its elements (#B953); no bag, or no req.params: nothing is copied and nothing throws', function () {
        var arr = ['a'];
        runBlock(true, { method: 'PUT', params: { 0: '/p', id: '43' }, put: arr, body: {} }, false, 'put');
        assert.equal(arr.id, '43', 'the URL value lands on the array');
        assert.equal(arr.length, 1, 'its length is unchanged');
        assert.equal(arr[0], 'a', 'its element is unchanged');
        runBlock(true, { method: 'PUT', params: { 0: '/p', id: '43' }, put: undefined, body: {} }, false, 'put');
        runBlock(true, { method: 'PUT', params: null, put: { id: '99' }, body: {} }, false, 'put');
    });
});
