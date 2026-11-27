'use strict';
/**
 * #B1163 — the dev Inspector EXPLAINed a Couchbase `bulkInsert`'s logged statement.
 *
 * A `bulkInsert` entry in the Inspector carries the statement as it is logged: by default
 * `INSERT INTO <keyspace> (KEY, VALUE) -- N record(s) [values redacted]`, the full statement
 * with its record values only when `inspector.queries.captureValues` is on (#B350). With no
 * `meta.profile` from the SDK, the index fallback ran an EXPLAIN of that string: the redacted
 * line is not a statement (Couchbase 8.0.2 answers it with error 3000), so the badge read N/A
 * after a failed round trip, cached once per record count; with captureValues on, the EXPLAIN
 * carried the record values and its cache entry kept them. The statement `bulkInsert` runs is
 * an `INSERT … VALUES … RETURNING`, whose plan reads no keyspace (8.0.2: ValueScan,
 * SendInsert, InitialProject). Fix: with no profile, the entry reports `no keyspace read` and
 * no EXPLAIN is sent.
 *
 * §01 lifts the profile check of `bulkInsert`'s result handler out of the comment-stripped
 * source and runs it with stubs for every name it may read; §02 pins it. Red-first:
 * GINA_B1163_CONNECTOR_SRC=<pre-fix connector> reds §01.1, §01.2 and §02.1–§02.3; §01.3 and
 * §01.4, the firing control, pass on both.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var commentStrip = require('../strip-comments');
var SOURCE = process.env.GINA_B1163_CONNECTOR_SRC || path.join(FW, 'core', 'connectors', 'couchbase', 'index.js');
var RAW = fs.readFileSync(SOURCE, 'utf8');
// Block comments and comment-only `//` lines out, by the exact strip (test/strip-comments.js)
var SRC = commentStrip.lines(RAW);

var CHECK   = 'if (_meta && _meta.profile) {';
var NO_READ = [ { name: 'no keyspace read', primary: false } ];

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * Index of the brace that closes the one opened at `open`.
 *
 * @param {string} src - The source text
 * @param {number} open - Index of an opening `{`
 * @returns {number} Index of its closing `}`
 */
function closeOf(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('extraction control: unbalanced braces from ' + open);
}

/**
 * The profile check of `bulkInsert`'s result handler as it ships: the `if` and its `else`.
 *
 * @returns {string} The statement's source text
 */
function liftCheck() {
    assert.equal(count(SRC, CHECK), 1, 'extraction control: the profile check is found once');
    var at    = SRC.indexOf(CHECK);
    var ifEnd = closeOf(SRC, at + CHECK.length - 1);
    var tail  = /^\s*else\s*\{/.exec(SRC.slice(ifEnd + 1));
    assert.ok(tail, 'extraction control: the profile check has an else branch');
    return SRC.slice(at, closeOf(SRC, ifEnd + tail[0].length) + 1);
}

/**
 * Runs a block with stubs for every name the shipped and the pre-fix forms read.
 *
 * @param {string} block - The source to run
 * @param {object} meta - The query result's `meta`
 * @returns {{entry: object, explains: number, cacheReads: number, profiles: number}} The entry
 *          and how often each stub was called
 */
function runBlock(block, meta) {
    var entry = { statement: 'INSERT INTO `sample` (KEY, VALUE) -- 2 record(s) [values redacted]', indexes: null };
    var seen  = { explains: 0, cacheReads: 0, profiles: 0 };
    var cache = {
        has: function () { seen.cacheReads++; return false; },
        get: function () { seen.cacheReads++; return null; },
        set: function () {}
    };
    new Function('_meta', '_biQueryEntry', 'extractIndexes', '_explainCache', 'explainForIndexes', 'conn', 'queryOptions',
        "'use strict';\n" + block)(
        meta, entry,
        function () { seen.profiles++; return [ { name: 'idx_from_profile', primary: false } ]; },
        cache,
        function () { seen.explains++; },
        {}, {}
    );
    return { entry: entry, explains: seen.explains, cacheReads: seen.cacheReads, profiles: seen.profiles };
}


// ---------------------------------------------------------------------------
describe('couchbase-bulkinsert-indexes-b1163 §01 — the profile check, executed', function () {

    it('01.1  no profile: the entry reports "no keyspace read"', function () {
        assert.deepEqual(runBlock(liftCheck(), {}).entry.indexes, NO_READ);
        assert.deepEqual(runBlock(liftCheck(), { status: 'success', metrics: { mutationCount: 2 } }).entry.indexes, NO_READ);
    });

    it('01.2  no profile: no EXPLAIN is sent and the EXPLAIN cache is not read', function () {
        var r = runBlock(liftCheck(), {});
        assert.equal(r.explains, 0, 'EXPLAIN calls');
        assert.equal(r.cacheReads, 0, 'EXPLAIN cache reads');
    });

    it('01.3  a profile: the entry takes its indexes, as before', function () {
        var r = runBlock(liftCheck(), { profile: { executionTimings: {} } });
        assert.deepEqual(r.entry.indexes, [ { name: 'idx_from_profile', primary: false } ]);
        assert.equal(r.profiles, 1, 'profile reads');
        assert.equal(r.explains, 0, 'EXPLAIN calls');
    });

    it('01.4  CONTROL — the runner counts an EXPLAIN and a cache read when a block makes them', function () {
        var r = runBlock('if (!_explainCache.has(_biQueryEntry.statement)) { explainForIndexes(conn, _biQueryEntry.statement, _biQueryEntry, queryOptions); }', {});
        assert.equal(r.explains, 1, 'EXPLAIN calls');
        assert.equal(r.cacheReads, 1, 'EXPLAIN cache reads');
        assert.equal(r.entry.indexes, null, 'the entry is left unread');
    });
});


// ---------------------------------------------------------------------------
describe('couchbase-bulkinsert-indexes-b1163 §02 — source pins', function () {

    it('02.1  the profile check holds no EXPLAIN call and no EXPLAIN cache read', function () {
        var block = liftCheck();
        assert.equal(block.indexOf('explainForIndexes('), -1, 'an EXPLAIN call');
        assert.equal(block.indexOf('_explainCache'), -1, 'an EXPLAIN cache read');
    });

    it('02.2  the entity query path holds the only EXPLAIN call site', function () {
        assert.equal(count(SRC, 'explainForIndexes(conn,'), 1);
    });

    it('02.3  CONTROL — the strip is proven: the #B1163 comment is in the raw source and not in the stripped one', function () {
        assert.ok(RAW.indexOf('// #B1163 — no EXPLAIN') > -1);
        assert.equal(SRC.indexOf('#B1163'), -1);
    });
});
