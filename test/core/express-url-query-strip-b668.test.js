'use strict';
/**
 * #B668 — engine:"express": every URL carrying a query string answered 404 on both
 * Express majors — `GET /getonly?x=1&y=2`, `HEAD /getonly?x=1`, `DELETE
 * /delstatic?x=1` all `Page not found` while the bare URL answered 200 (measured
 * live on express@5.2.1 and @4.22.3, released v0.6.33 and develop; isaac: 200 with
 * the keys).
 *
 * Mechanism: isaac rewrites `request.url` to the bare path after parsing the query
 * (server.isaac.js), before dispatch. The express engine never did, so the pathname
 * `loadBundleConfiguration` hands to `handle()` kept `?…` glued to its last segment,
 * `parseRouting` split it as the request path and the last segment never equalled
 * the rule's; `handleStatics` and `fitsWithRequirements` read the same
 * query-carrying `request.url`.
 *
 * Fix (core/server.js, the catch-all's pre-dispatch band): for the express engine,
 * materialise the engine's query parse on `request.query` — the server.express.js
 * accessor (#B666) reads the URL lazily, so the read MUST precede the strip — then
 * strip `request.url` to its path. Placed after every `/_gina/*` handler (they read
 * `?key=` off the full URL) and before the webroot filter, the statics and the
 * routing loop. `request.originalUrl` keeps the full URL.
 *
 * Red-first: GINA_SERVER_SRC=<pre-fix server.js> reds every pin and every
 * behavioural arm except the controls.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core', 'server.js');
var SERVER = fs.readFileSync(SOURCE, 'utf8');

// line comments FIRST, then block comments: a `/*` inside a `// …` line (a
// `/_gina/*` mention) would otherwise open a phantom block comment that swallows
// everything up to the next `*/` — measured on this very block's first draft.
function stripComments(src) {
    return src
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}
var SERVER_ST = stripComments(SERVER);

var GATE = 'if ( /^express/.test(self.engine) ) {\n                var _exQuery = request.query;';

function extractBlock(src) {
    var start = src.indexOf(GATE);
    assert.ok(start > -1, 'extraction control: the #B668 block must open on the express gate');
    assert.equal(src.indexOf(GATE, start + 1), -1, 'extraction control: exactly one such block');
    var end = src.indexOf('_exQuery = null; _exQi = null;\n            }', start);
    assert.ok(end > -1, 'extraction control: the block must close after releasing its locals');
    return src.slice(start, src.indexOf('}', end) + 1);
}

function runBlock(block, engine, reqUrl, parsed) {
    var reads = [];
    var request = { url: reqUrl };
    Object.defineProperty(request, 'query', {
        configurable: true, enumerable: false,
        get: function () { reads.push(this.url); return parsed; }
    });
    var fn = new Function('request', 'self', "'use strict';\n" + block + '\nreturn request.url;');
    var out = fn(request, { engine: engine });
    return { url: out, reads: reads };
}

// ---------------------------------------------------------------------------
describe('express-url-query-strip-b668 §01 — source pins', function () {

    it('the block exists once and is express-gated', function () {
        extractBlock(SERVER_ST);
    });

    it('the query is materialised BEFORE the URL loses it (the accessor reads the URL lazily)', function () {
        var block = extractBlock(SERVER_ST);
        var read  = block.indexOf('var _exQuery = request.query;');
        var strip = block.indexOf('request.url = request.url.substring(0, _exQi);');
        assert.ok(read > -1 && strip > -1);
        assert.ok(read < strip, 'materialise first, strip second');
    });

    it('placement: after the maintenance gate (the last /_gina-side band) and before the webroot filter', function () {
        var block = SERVER_ST.indexOf(GATE);
        var maint = SERVER_ST.lastIndexOf('_serveMaintenance(request, response, _mtConf)', block);
        var webroot = SERVER_ST.indexOf('var isWebrootHandledByRouting', block);
        var lastGina = SERVER_ST.lastIndexOf("'/_gina/", block);
        assert.ok(maint > -1 && maint < block, 'the maintenance gate precedes the strip');
        assert.ok(lastGina > -1 && lastGina < block, 'every /_gina/* handler literal in the catch-all precedes the strip');
        assert.ok(webroot > block, 'the webroot filter follows the strip');
        assert.ok(webroot - block < 2000, 'the strip sits immediately ahead of the webroot filter');
    });

    it('isaac still strips the query in its own listener (the contract this mirrors)', function () {
        var ISAAC = fs.readFileSync(path.join(FW, 'core', 'server.isaac.js'), 'utf8');
        assert.ok(ISAAC.indexOf("request.url = request.url.split('?')[0]") > -1);
    });
});

// ---------------------------------------------------------------------------
describe('express-url-query-strip-b668 §02 — the SHIPPED block, extracted and executed', function () {

    it('express: the query is read while the URL still carries it, then the URL is its bare path', function () {
        var r = runBlock(extractBlock(SERVER_ST), 'express', '/app/getonly?x=1&y=2', { x: '1', y: '2' });
        assert.equal(r.url, '/app/getonly');
        assert.deepEqual(r.reads, ['/app/getonly?x=1&y=2'], 'exactly one read, taken BEFORE the strip');
    });

    it('express: a URL without a query is untouched, the query still materialised', function () {
        var r = runBlock(extractBlock(SERVER_ST), 'express', '/app/getonly', {});
        assert.equal(r.url, '/app/getonly');
        assert.equal(r.reads.length, 1);
    });

    it('express: only the first `?` splits — a second one belongs to the query', function () {
        var r = runBlock(extractBlock(SERVER_ST), 'express', '/app/x?a=1?b=2', {});
        assert.equal(r.url, '/app/x');
    });

    it('CONTROL — isaac: the block is inert (no read, no strip)', function () {
        var r = runBlock(extractBlock(SERVER_ST), 'isaac', '/app/getonly?x=1', { x: '1' });
        assert.equal(r.url, '/app/getonly?x=1');
        assert.equal(r.reads.length, 0);
    });
});
