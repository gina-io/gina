/**
 * #B744 — the miss-path `Cache-Control: <visibility>, max-age=<ttl>` header rides the
 * write's own gate: the server cache ON (`server.cache.enable === 'true'`), a GET, and a
 * route `cache`. Until 0.7.4 the header went out on every response of a route carrying
 * `cache`, whatever the switch (dev with the cache off included) and whatever the method —
 * the block sat after the write gate instead of inside it, while #C6 had designed it
 * « after each cached response ».
 *
 * Four sites, in lockstep: controller.render-swig.js (the compiled-template-cache hit
 * branch and the compile path), controller.render-json.js, controller.render-nunjucks.js.
 * Each block is EXTRACTED from the shipped source (anchor → the balanced `if` block) and
 * executed against fakes — real bytes, no replica — so a site that drifts from the gate
 * fails here. The extraction count per file is a control (swig 2, json 1, nunjucks 1).
 *
 * Seams: GINA_RENDER_SWIG_SRC / GINA_RENDER_JSON_SRC / GINA_RENDER_NUNJUCKS_SRC=<file> run
 * every arm against that text. Red-first: against `git show HEAD~:` of the pre-#B744 bytes
 * the « switch off » and « POST » arms emit the header and fail; the « on + GET » arms pass
 * on both (they are the premise, not the discrimination).
 *
 * Usage: node --test test/core/render-cache-control-b744.test.js
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');
var SOURCES = {
    swig     : process.env.GINA_RENDER_SWIG_SRC     || path.join(FW, 'core/controller/controller.render-swig.js'),
    json     : process.env.GINA_RENDER_JSON_SRC     || path.join(FW, 'core/controller/controller.render-json.js'),
    nunjucks : process.env.GINA_RENDER_NUNJUCKS_SRC || path.join(FW, 'core/controller/controller.render-nunjucks.js')
};
var EXPECTED_SITES = { swig: 2, json: 1, nunjucks: 1 };
var ANCHOR = '// Cache-Control: miss path';

/**
 * Every miss-path Cache-Control block of one delegate: from the anchor comment to the
 * balanced close of the `if` that follows it. Brace-walked; the comment lines between
 * carry no brace (asserted by the balance check).
 * @param {string} src
 * @returns {string[]}
 * @inner
 */
function extractBlocks(src) {
    var out = [], from = 0;
    for (;;) {
        var at = src.indexOf(ANCHOR, from);
        if (at === -1) break;
        var ifAt = src.indexOf('if (', at);
        assert.notStrictEqual(ifAt, -1, 'no `if (` after the anchor at ' + at);
        var i = src.indexOf('{', ifAt), depth = 0;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) break; }
        }
        assert.strictEqual(depth, 0, 'unbalanced block after the anchor at ' + at);
        out.push(src.slice(at, i + 1));
        from = i + 1;
    }
    return out;
}

/**
 * Runs one extracted block against a scene and answers the Cache-Control it set.
 * swig / nunjucks set it through `res.setHeader`; json computes `_cc` and the caller
 * applies it later, so the json block is run with a `return _cc` tail.
 * @param {string} kind - swig | json | nunjucks
 * @param {string} block
 * @param {object} scene - { enabled, method, routeCache, serverTtl }
 * @returns {string|null}
 * @inner
 */
function run(kind, block, scene) {
    var self = { serverInstance: { _cacheIsEnabled: scene.enabled } };
    var routing = {};
    if (typeof scene.routeCache !== 'undefined') routing.cache = scene.routeCache;
    var conf = { server: { cache: { ttl: scene.serverTtl } } };
    /* eslint-disable no-new-func */
    if (kind === 'json') {
        var fnJ = new Function('self', 'request', 'local', block + '\nreturn _cc;');
        return fnJ(self, { method: scene.method, routing: routing }, { options: { conf: conf } });
    }
    var set = null;
    var res = { setHeader: function(name, value) { if (name === 'Cache-Control') set = value; } };
    var fn = new Function('self', 'req', 'res', 'localOptions', block);
    fn(self, { method: scene.method, routing: routing }, res, { conf: conf });
    return set;
}

var MATRIX = [
    { name: 'on + GET + route ttl 60 → private, max-age=60',                 scene: { enabled: 'true',  method: 'GET',  routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: 'private, max-age=60' },
    { name: 'on (boolean true) + GET → the string form of the flag is honoured', scene: { enabled: true, method: 'GET',  routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: 'private, max-age=60' },
    { name: 'on + GET + no route ttl → the bundle default ttl',               scene: { enabled: 'true',  method: 'GET',  routeCache: { type: 'memory' },          serverTtl: 120 },  expect: 'private, max-age=120' },
    { name: 'on + GET + string shorthand cache → the bundle default ttl',     scene: { enabled: 'true',  method: 'GET',  routeCache: 'memory',                    serverTtl: 120 },  expect: 'private, max-age=120' },
    { name: 'on + GET + visibility public → public',                          scene: { enabled: 'true',  method: 'GET',  routeCache: { type: 'memory', ttl: 30, visibility: 'public' }, serverTtl: 3600 }, expect: 'public, max-age=30' },
    { name: 'on + lower-case get → method compare is case-insensitive',       scene: { enabled: 'true',  method: 'get',  routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: 'private, max-age=60' },
    { name: 'on + GET + no ttl anywhere → no header',                         scene: { enabled: 'true',  method: 'GET',  routeCache: { type: 'memory' },          serverTtl: 0 },    expect: null },
    { name: 'on + GET + no route cache → no header',                          scene: { enabled: 'true',  method: 'GET',                                            serverTtl: 3600 }, expect: null },
    { name: 'OFF (false) + GET + route cache → NO header (#B744)',            scene: { enabled: false,   method: 'GET',  routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: null },
    { name: 'OFF ("false") + GET + route cache → NO header (#B744)',          scene: { enabled: 'false', method: 'GET',  routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: null },
    { name: 'OFF (undefined) + GET + route cache → NO header (#B744)',        scene: { enabled: undefined, method: 'GET', routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: null },
    { name: 'on + POST + route cache → NO header (#B744: the write is GET-only)', scene: { enabled: 'true', method: 'POST', routeCache: { type: 'memory', ttl: 60 }, serverTtl: 3600 }, expect: null }
];

Object.keys(SOURCES).forEach(function(kind) {
    describe('#B744 — miss-path Cache-Control gate: ' + kind, function() {
        var src    = fs.readFileSync(SOURCES[kind], 'utf8');
        var blocks = extractBlocks(src);

        it('extracts exactly ' + EXPECTED_SITES[kind] + ' miss-path block(s) (control)', function() {
            assert.strictEqual(blocks.length, EXPECTED_SITES[kind]);
        });

        it('every block gates on the switch, the method and the route cache (source pin)', function() {
            blocks.forEach(function(block) {
                assert.match(block, /_cacheIsEnabled/, 'the switch is read');
                assert.match(block, /GET/, 'the method is compared');
                assert.match(block, /routing\.cache/, 'the route cache is read');
            });
        });

        MATRIX.forEach(function(row) {
            it(row.name, function() {
                blocks.forEach(function(block, i) {
                    assert.strictEqual(run(kind, block, row.scene), row.expect, kind + ' site #' + (i + 1));
                });
            });
        });
    });
});

describe('#B744 — the four sites agree on every scene (lockstep)', function() {
    it('identical outcomes across swig ×2, json and nunjucks', function() {
        var all = [];
        Object.keys(SOURCES).forEach(function(kind) {
            extractBlocks(fs.readFileSync(SOURCES[kind], 'utf8')).forEach(function(block) {
                all.push({ kind: kind, block: block });
            });
        });
        assert.strictEqual(all.length, 4, 'four sites');
        MATRIX.forEach(function(row) {
            var outcomes = all.map(function(s) { return run(s.kind, s.block, row.scene); });
            assert.ok(outcomes.every(function(o) { return o === outcomes[0]; }), row.name + ': ' + JSON.stringify(outcomes));
        });
    });
});
