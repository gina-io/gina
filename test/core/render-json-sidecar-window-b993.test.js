'use strict';
/**
 * #B993 — `self.renderJSON()` attaches the Inspector sidecars (`__ginaQueries`, `__ginaFlow`) in
 * dev only.
 *
 * #INS10 also attached them during a production instrumentation window when the request carried
 * `x-gina-inspector: true`, the header `self.query()` sets on a cross-bundle call. Any client can
 * send that header, so while a window was open an unauthenticated request received its own raw
 * query log (the statement text, the `.sql` file's server path, the bound values with
 * `inspector.queries.captureValues`) and its timeline, in the JSON body; measured on a booted
 * production bundle on 2026-10-28. Since 0.7.7 both gates read `self.isCacheless()` alone, and the
 * window's capture leaves only over the authenticated `/_gina/agent` channel.
 *
 * The arms run the SHIPPED bytes of the sidecar block (from `// #QI — embed query log as a
 * sidecar` to `// #DTO2`) with supplied inputs, as render-json-sidecar-copy-b992.test.js does.
 *
 * Arms:
 *   §00 instrument validation - the anchors fire, the block extracts, the strip removes the
 *       comment lines, and the raw block still names the header, so the negative pins of §01 read
 *       live code and cannot pass on an empty or unstripped block
 *   §01 source pins - neither live gate reads the window or the header [red pre-fix]; both still
 *       read `self.isCacheless()`; the JSON emit gate still opens on the window
 *   §02 the extracted block - a window request with the header gets no sidecar [red pre-fix];
 *       controls: in dev both sidecars are attached; a window request without the header and a
 *       request with the header after the window get none
 *
 * Seam: `GINA_B993_SRC=<render-json.js>` reads that file instead of the tree's (red-first against
 * the pre-fix bytes); `GINA_B993_DATA=<render-data.js>` loads that file's `copyOwn()`.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW       = require('../fw');
var SRC_JSON = process.env.GINA_B993_SRC  || path.join(FW, 'core/controller/controller.render-json.js');
var SRC_DATA = process.env.GINA_B993_DATA || path.join(FW, 'core/controller/render-data.js');

var raw = fs.readFileSync(SRC_JSON, 'utf8');

var START  = '// #QI — embed query log as a sidecar';
var END    = '// #DTO2';
var HEADER = 'x-gina-inspector';
var WINDOW = '_inspectorWindowUntil';

/**
 * Drops comment lines (the #B672 / #B554 strip).
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
 * The live `if (…)` line that guards one sidecar assignment.
 *
 * @inner
 * @param {string} assignment - the assignment statement the gate guards
 * @returns {string} the gate line, or '' when the assignment is not found
 */
function gateOf(assignment) {
    var a = LIVE.indexOf(assignment);
    if (a < 0) { return ''; }
    var g = LIVE.lastIndexOf('if (', a);
    return g < 0 ? '' : LIVE.slice(g, LIVE.indexOf('\n', g));
}

var Q_GATE = gateOf('jsonObj.__ginaQueries = local._queryLog;');
var F_GATE = gateOf('jsonObj.__ginaFlow = local._timeline.entries;');

/**
 * Runs the shipped block once, as renderJSON runs it, and returns the object it hands on to the
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

var Q = [{ statement: 'SELECT name FROM items WHERE id = ?', params: ['[string]'], source: '/srv/app/models/db/sql/item/byId.sql' }];
var F = [{ label: 'total', cat: 'response', durationMs: 3 }];
var WITH_HEADER = { 'x-gina-inspector': 'true' };


describe('#B993 §00 - instrument validation', function () {

    it('the anchors fire, the block extracts and the strip removes the comment lines', function () {
        assert.ok(BLOCK && BLOCK.length > 200, 'the sidecar block must extract from ' + SRC_JSON);
        assert.ok(LIVE.length < BLOCK.length, 'the strip must remove the comment lines');
        assert.equal(raw.indexOf('zz-b993-bogus-token'), -1);
    });

    it('both gates are found in live code, and the raw block still names the header', function () {
        assert.ok(Q_GATE.length > 0, 'the __ginaQueries gate must be found');
        assert.ok(F_GATE.length > 0, 'the __ginaFlow gate must be found');
        assert.ok(BLOCK.indexOf(HEADER) > -1, 'the raw block names the header (pre-fix: the gates; since the fix: the commented-out gates)');
    });
});


describe('#B993 §01 - source pins', function () {

    it('the __ginaQueries gate reads neither the window nor the header', function () {
        assert.equal(Q_GATE.indexOf(WINDOW), -1, '#B993: the __ginaQueries gate opens on the instrumentation window: ' + Q_GATE.trim());
        assert.equal(Q_GATE.indexOf(HEADER), -1, '#B993: the __ginaQueries gate trusts the client header: ' + Q_GATE.trim());
    });

    it('the __ginaFlow gate reads neither the window nor the header', function () {
        assert.equal(F_GATE.indexOf(WINDOW), -1, '#B993: the __ginaFlow gate opens on the instrumentation window: ' + F_GATE.trim());
        assert.equal(F_GATE.indexOf(HEADER), -1, '#B993: the __ginaFlow gate trusts the client header: ' + F_GATE.trim());
    });

    it('CONTROL - both gates still read self.isCacheless()', function () {
        assert.ok(Q_GATE.indexOf('self.isCacheless()') > -1, Q_GATE.trim());
        assert.ok(F_GATE.indexOf('self.isCacheless()') > -1, F_GATE.trim());
    });

    it('CONTROL - the JSON emit to the authenticated channel still opens on the window', function () {
        var e = raw.indexOf('#INS — emit Inspector payload');
        assert.ok(e > -1, 'the emit anchor must be found');
        assert.ok(raw.substring(e, e + 500).indexOf('process.gina._inspectorWindowUntil > Date.now()') > -1,
            'the emit gate must still open on the window');
    });
});


describe('#B993 §02 - the shipped sidecar block', function () {

    it('a window request carrying the header gets no __ginaQueries and no __ginaFlow', function () {
        var obj = { name: 'b993' };
        var out = run(obj, { windowUntil: Date.now() + 60000, headers: WITH_HEADER, queries: Q, flow: F });
        assert.equal(out.__ginaQueries, undefined, '#B993: a client with the header received the query log');
        assert.equal(out.__ginaFlow, undefined, '#B993: a client with the header received the timeline');
        assert.equal(JSON.stringify(out).indexOf('SELECT'), -1, '#B993: the statement text reached the response');
        assert.deepEqual(Object.keys(obj), ['name']);
    });

    it('CONTROL - in dev, both sidecars are attached (the block can write them)', function () {
        var out = run({ name: 'b993' }, { dev: true, queries: Q, flow: F });
        assert.deepEqual(out.__ginaQueries, Q, 'harness fault: the dev sidecar was not written');
        assert.deepEqual(out.__ginaFlow, F);
    });

    it('CONTROL - a window request without the header gets nothing', function () {
        var out = run({ name: 'b993' }, { windowUntil: Date.now() + 60000, queries: Q, flow: F });
        assert.equal(out.__ginaQueries, undefined);
        assert.equal(out.__ginaFlow, undefined);
    });

    it('CONTROL - a request with the header after the window gets nothing', function () {
        var out = run({ name: 'b993' }, { windowUntil: Date.now() - 1, headers: WITH_HEADER, queries: Q, flow: F });
        assert.equal(out.__ginaQueries, undefined);
        assert.equal(out.__ginaFlow, undefined);
    });
});
