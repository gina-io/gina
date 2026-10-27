'use strict';
/**
 * #B992 — `self.renderJSON()` writes its Inspector sidecars into a copy of the object an action
 * passes, never into the object itself.
 *
 * In development, and during a production instrumentation window for a request carrying
 * `x-gina-inspector: true`, renderJSON adds the request's query log (`__ginaQueries`) and its
 * timeline (`__ginaFlow`) to the response object when they are not empty. Up to 0.7.5 it added
 * them to the action's own object, so an object the action passes to several renderJSON calls (a
 * memoized response) kept the first request's sidecars, and every later response that reused it
 * sent them, to any client and after the window had closed. The fix writes them into a copy made
 * by `copyOwn()` (core/controller/render-data.js), once per render.
 *
 * The writes need a non-empty query log, which a booted scene without a datastore cannot produce,
 * so the arms run the SHIPPED bytes of the sidecar block (from `// #QI — embed query log as a
 * sidecar` to `// #DTO2`) with supplied inputs.
 *
 * Arms:
 *   §00 instrument validation - the anchors fire, the block extracts, and the old assignments are
 *       still in it (the pins of §01 can fail)
 *   §01 source pins - render-json requires render-data once; each sidecar write is preceded by the
 *       copy; the two assignment statements are unchanged
 *   §02 the extracted block - control: no query log, nothing written; a window request with the
 *       header and a query gets the sidecar on a copy and the memoized object stays as it was; an
 *       external request in the window and a request after it send nothing of the first; in dev,
 *       one copy carries both sidecars; a class instance keeps the old behaviour
 *
 * Seam: `GINA_B992_SRC=<render-json.js>` reads that file instead of the tree's (red-first against
 * a pre-fix tree); `GINA_B992_DATA=<render-data.js>` loads that file's `copyOwn()`.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW       = require('../fw');
var SRC_JSON = process.env.GINA_B992_SRC  || path.join(FW, 'core/controller/controller.render-json.js');
var SRC_DATA = process.env.GINA_B992_DATA || path.join(FW, 'core/controller/render-data.js');

var raw = fs.readFileSync(SRC_JSON, 'utf8');

var START = '// #QI — embed query log as a sidecar';
var END   = '// #DTO2';

/**
 * Drop comment lines (the #B672 / #B554 strip).
 *
 * @inner
 * @param {string} source
 * @returns {string} the live lines only
 */
function stripComments(source) {
    return source.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/** @inner @param {string} hay @param {string} needle @returns {number} */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The sidecar block as shipped: from its first comment line to the #DTO2 comment.
 *
 * @inner
 * @returns {string|null}
 */
function block() {
    var i = raw.indexOf(START);
    var j = raw.indexOf(END, i);
    if (i < 0 || j < 0) { return null; }
    return raw.slice(i, j);
}

var BLOCK = block();
var LIVE  = BLOCK ? stripComments(BLOCK) : '';

/**
 * Run the shipped block once, as renderJSON runs it, and return the object it hands on to the
 * DTO step and `JSON.stringify()`.
 *
 * @inner
 * @param {object} jsonObj - the action's object
 * @param {object} o
 * @param {boolean} [o.dev] - `self.isCacheless()`
 * @param {number} [o.windowUntil] - `process.gina._inspectorWindowUntil`
 * @param {object} [o.headers] - the request headers
 * @param {Array} [o.queries] - `local._queryLog`
 * @param {Array} [o.flow] - `local._timeline.entries`
 * @returns {object} the object after the block
 */
function run(jsonObj, o) {
    var self    = { isCacheless: function () { return !!o.dev; } };
    var local   = { _queryLog: o.queries || [], _timeline: { entries: o.flow || [] } };
    var request = { headers: o.headers || {} };
    var proc    = { gina: { _inspectorWindowUntil: o.windowUntil || 0 } };
    var renderData = require(SRC_DATA);
    var fn = new Function('renderData', 'self', 'local', 'request', 'process', 'jsonObj',
        BLOCK + '\nreturn jsonObj;');
    return fn(renderData, self, local, request, proc, jsonObj);
}

var Q_A = [{ statement: 'SELECT * FROM accounts WHERE id = $1', params: ['<number>'] }];
var F_A = [{ label: 'query', duration: 3 }];
var HEADER = { 'x-gina-inspector': 'true' };


describe('#B992 §00 - instrument validation', function () {

    it('the anchors fire and the block extracts', function () {
        assert.ok(BLOCK && BLOCK.length > 200, 'the sidecar block must extract from ' + SRC_JSON);
        assert.ok(LIVE.length < BLOCK.length, 'the strip must remove the comment lines');
        assert.equal(raw.indexOf('zz-b992-bogus-token'), -1);
    });

    it('the two sidecar assignments are in the block (live code)', function () {
        assert.equal(countOf(LIVE, 'jsonObj.__ginaQueries = local._queryLog;'), 1);
        assert.equal(countOf(LIVE, 'jsonObj.__ginaFlow = local._timeline.entries;'), 1);
    });
});


describe('#B992 §01 - source pins', function () {

    it('render-json requires core/controller/render-data once', function () {
        var m = stripComments(raw).match(/var renderData\s*=\s*require\('\.\/render-data'\);/g) || [];
        assert.equal(m.length, 1, '#B992: render-json does not require ./render-data');
    });

    it('each sidecar write is preceded, in its own block, by the copy', function () {
        var copies = LIVE.match(/jsonObj = _sidecarCopy = _sidecarCopy \|\| renderData\.copyOwn\(jsonObj\);/g) || [];
        assert.equal(copies.length, 2, '#B992: expected the copy before each of the two sidecar writes');
        var q = LIVE.indexOf('jsonObj.__ginaQueries = local._queryLog;');
        var f = LIVE.indexOf('jsonObj.__ginaFlow = local._timeline.entries;');
        var c1 = LIVE.indexOf('renderData.copyOwn(jsonObj)');
        var c2 = LIVE.indexOf('renderData.copyOwn(jsonObj)', c1 + 1);
        assert.ok(c1 > -1 && c1 < q, 'the copy precedes the __ginaQueries write');
        assert.ok(c2 > q && c2 < f, 'the copy precedes the __ginaFlow write');
    });
});


describe('#B992 §02 - the shipped sidecar block', function () {

    it('CONTROL - no query log and no timeline: nothing is written, the object is handed on as is', function () {
        var memo = { items: [1, 2] };
        var out  = run(memo, { dev: true });
        assert.equal(out, memo);
        assert.deepEqual(Object.keys(memo), ['items']);
    });

    it('a window request with the header and a query: the response carries its log, the memoized object does not', function () {
        var memo = { items: [1, 2] };
        var out  = run(memo, { windowUntil: Date.now() + 60000, headers: HEADER, queries: Q_A });
        assert.deepEqual(out.__ginaQueries, Q_A, 'harness fault: the sidecar was not written');
        assert.equal(out.items, memo.items, 'a member is shared');
        assert.deepEqual(Object.keys(memo), ['items'], '#B992: the sidecar was written into the action\'s object');
    });

    it('an external request in the window, then a request after it: neither sends the first request\'s log', function () {
        var memo = { items: [1, 2] };
        run(memo, { windowUntil: Date.now() + 60000, headers: HEADER, queries: Q_A });
        var b = run(memo, { windowUntil: Date.now() + 60000 });
        var c = run(memo, { windowUntil: Date.now() - 1 });
        assert.equal(JSON.stringify(b).indexOf('SELECT'), -1, '#B992: an external request sent the window request\'s query log');
        assert.equal(JSON.stringify(c).indexOf('SELECT'), -1, '#B992: a request after the window sent the window request\'s query log');
    });

    it('in dev, a query log and a timeline: one copy carries both, the memoized object stays as it was', function () {
        var memo = { items: [1, 2] };
        var out  = run(memo, { dev: true, queries: Q_A, flow: F_A });
        assert.notEqual(out, memo);
        assert.deepEqual(out.__ginaQueries, Q_A);
        assert.deepEqual(out.__ginaFlow, F_A);
        assert.deepEqual(Object.keys(memo), ['items'], '#B992: a sidecar was written into the action\'s object');
    });

    it('in dev, a timeline alone: the copy carries it, the memoized object stays as it was', function () {
        var memo = { items: [1, 2] };
        var out  = run(memo, { dev: true, flow: F_A });
        assert.deepEqual(out.__ginaFlow, F_A);
        assert.equal(out.__ginaQueries, undefined);
        assert.deepEqual(Object.keys(memo), ['items'], '#B992: the timeline was written into the action\'s object');
    });

    it('CONTROL - a class instance is not copied and keeps the old behaviour', function () {
        class Payload { constructor() { this.items = [1, 2]; } }
        var inst = new Payload();
        var out  = run(inst, { dev: true, queries: Q_A });
        assert.equal(out, inst);
        assert.deepEqual(inst.__ginaQueries, Q_A);
    });
});
