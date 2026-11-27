'use strict';
/**
 * #B1162 — the Couchbase plan walker labelled an `ExpressionScan` « KV lookup (USE KEYS) ».
 *
 * The dev Inspector's index badge for a Couchbase statement comes from its EXPLAIN plan. Measured
 * on Couchbase 8.0.2: a `USE KEYS` read plans as `KeyScan` + `Fetch`, and a FROM over an
 * expression (`SELECT RAW d.x FROM [ { "x": 1 } ] AS d`) plans as an `ExpressionScan`, which
 * reads no keyspace. `extractIndexes` matched both operators to the key-lookup label, so a
 * statement that reads nothing showed the green « KV lookup (USE KEYS) » chip, and one that reads
 * through an index showed that chip beside the index. Fix: `KeyScan` alone is the key lookup;
 * `extractExplainIndexes` counts an `ExpressionScan` as a no-read source, beside `DummyScan` and
 * `ValueScan`, so a plan whose only source is one reports `no keyspace read`, and beside a read
 * it adds nothing.
 *
 * §01 runs the connector's own functions, lifted from its source by brace counting as
 * inspector.test.js §30 and §92 do, on the two plans measured on 8.0.2 (names neutralized) and on
 * rows built from them; §02 pins the source. Red-first: GINA_B1162_CONNECTOR_SRC=<pre-fix
 * connector> reds §01.2–§01.6 and §02.1–§02.2; §00.1 and §01.1 (USE KEYS), the firing control,
 * pass on both.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var commentStrip = require('../strip-comments');
var SOURCE = process.env.GINA_B1162_CONNECTOR_SRC || path.join(FW, 'core', 'connectors', 'couchbase', 'index.js');
var RAW = fs.readFileSync(SOURCE, 'utf8');
// Every comment out, by the exact strip (test/strip-comments.js): the pins read code only
var CODE = commentStrip.all(RAW);

var KV_LOOKUP = [ { name: 'KV lookup (USE KEYS)', primary: false } ];
var NO_READ   = [ { name: 'no keyspace read', primary: false } ];

/**
 * A function's source text, from its opening text to the brace that closes it.
 *
 * @param {string} src - The source text
 * @param {string} head - The function's opening text, e.g. `var extractIndexes = function(profile)`
 * @returns {string} The function's source, or '' when `head` is absent
 */
function sliceFn(src, head) {
    var start = src.indexOf(head);
    if (start < 0) return '';
    var depth = 0;
    for (var i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.substring(start, i + 1); }
    }
    return '';
}

var EXTRACT_SRC = sliceFn(RAW, 'var extractIndexes = function(profile)');
var EXPLAIN_SRC = sliceFn(RAW, 'var extractExplainIndexes = function(row)');
// extractExplainIndexes calls extractIndexes: both are defined in one scope (neither reads any
// other name of the connector's closure)
var fns = null, liftError = null;
try {
    fns = new Function(EXTRACT_SRC + '\n' + EXPLAIN_SRC +
        '\nreturn { extractIndexes: extractIndexes, extractExplainIndexes: extractExplainIndexes };')();
} catch (e) {
    liftError = e;
}

function walk(row)   { return fns.extractExplainIndexes(row); }
function names(list) { return (list || []).map(function (ix) { return ix.name; }); }

// -- EXPLAIN rows measured on Couchbase 8.0.2 (keyspace, document key and alias neutralized) --

// SELECT RAW META(t).id FROM sample AS t USE KEYS "k1"
function useKeysRow() {
    return {
        plan: { '#operator': 'Sequence', '~children': [
            { '#operator': 'KeyScan', keys: '"k1"' },
            { '#operator': 'Fetch', as: 't', keyspace: 'sample', namespace: 'default' },
            { '#operator': 'Parallel', maxParallelism: 1, '~child': { '#operator': 'Sequence', '~children': [
                { '#operator': 'InitialProject', discard_original: true, preserve_order: true, raw: true,
                    result_terms: [ { expr: '(meta(`t`).`id`)' } ] }
            ] } }
        ] },
        text: 'SELECT RAW META(t).id FROM sample AS t USE KEYS "k1"'
    };
}

// SELECT RAW d.x FROM [ { "x": 1 } ] AS d
function fromExpressionPlan() {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'ExpressionScan', alias: 'd', expr: '[{"x": 1}]', uncorrelated: true },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'InitialProject', discard_original: true, preserve_order: true, raw: true,
                result_terms: [ { expr: '(`d`.`x`)' } ] }
        ] } }
    ] };
}

// -- rows built from them: an index read, a statement that reads nothing, a subquery entry --

function indexPlan(name) {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'IndexScan3', index: name, keyspace: 'sample', namespace: 'default', using: 'gsi' },
        { '#operator': 'Fetch', keyspace: 'sample', namespace: 'default' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'Filter' }, { '#operator': 'InitialProject' }
        ] } }
    ] };
}
function dummyPlan() {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'DummyScan' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'Let' }, { '#operator': 'InitialProject' }
        ] } }
    ] };
}
// a `~subqueries` entry, as Couchbase 8.0.2 lists one beside `plan`
function sub(plan) {
    return { correlated: false, plan: plan, subquery: 'select raw ...' };
}


describe('00 - the connector\'s walker functions are lifted from its source', function () {

    it('00.1  extractIndexes and extractExplainIndexes are found and compile', function () {
        assert.ok(EXTRACT_SRC.length > 0, 'expected var extractIndexes = function(profile) in the couchbase connector');
        assert.ok(EXPLAIN_SRC.length > 0, 'expected var extractExplainIndexes = function(row) in the couchbase connector');
        assert.equal(liftError, null, 'the lifted functions do not compile: ' + liftError);
        assert.equal(typeof fns.extractExplainIndexes, 'function');
    });
});


describe('01 - an ExpressionScan is not a KV lookup (#B1162)', function () {

    it('01.1  USE KEYS (KeyScan + Fetch, measured on 8.0.2) reports « KV lookup (USE KEYS) »: the firing control', function () {
        assert.deepEqual(walk(useKeysRow()), KV_LOOKUP);
    });

    it('01.2  a FROM over an array literal (ExpressionScan, measured on 8.0.2) reports « no keyspace read »', function () {
        assert.deepEqual(walk({ plan: fromExpressionPlan(), text: 'SELECT RAW d.x FROM [ { "x": 1 } ] AS d' }), NO_READ);
    });

    it('01.3  extractIndexes adds no entry for an ExpressionScan', function () {
        assert.deepEqual(fns.extractIndexes(fromExpressionPlan()), []);
    });

    it('01.4  a subquery over an expression beside an index read adds nothing: only the index', function () {
        var row = { plan: indexPlan('idx_a'), '~subqueries': [ sub(fromExpressionPlan()) ] };
        assert.deepEqual(names(walk(row)), ['idx_a']);
    });

    it('01.5  a statement that reads nothing, with a subquery over an expression, reports « no keyspace read » once', function () {
        var row = { plan: dummyPlan(), '~subqueries': [ sub(fromExpressionPlan()) ] };
        assert.deepEqual(walk(row), NO_READ);
    });

    it('01.6  conservative: an ExpressionScan beside an operator outside the no-read set keeps the plain []', function () {
        var plan = fromExpressionPlan();
        plan['~children'].push({ '#operator': 'SomeFutureScan', keyspace: 'sample' });
        assert.deepEqual(walk({ plan: plan }), []);
    });
});


describe('02 - source pins: the fix cannot be silently reverted', function () {

    it('02.1  extractIndexes labels a KeyScan alone (/KeyScan/i), never an ExpressionScan', function () {
        var code = sliceFn(CODE, 'var extractIndexes = function(profile)');
        assert.ok(code.length > 0, 'expected extractIndexes in the comment-stripped source');
        assert.ok(code.indexOf('/KeyScan/i.test(op)') > -1, 'expected /KeyScan/i.test(op) in extractIndexes');
        assert.equal(code.indexOf('ExpressionScan'), -1, 'expected no ExpressionScan in the code of extractIndexes');
        // strip control: the raw function still names ExpressionScan (its comment), so the strip removed comments only
        assert.ok(EXTRACT_SRC.indexOf('ExpressionScan') > -1, 'strip control: the raw extractIndexes names ExpressionScan');
    });

    it('02.2  extractExplainIndexes counts an ExpressionScan as a no-read source', function () {
        var code = sliceFn(CODE, 'var extractExplainIndexes = function(row)');
        assert.ok(code.length > 0, 'expected extractExplainIndexes in the comment-stripped source');
        var list = /var noRead = \[([^\]]*)\]/.exec(code);
        assert.ok(list, 'expected the noRead list in extractExplainIndexes');
        assert.ok(list[1].indexOf("'ExpressionScan'") > -1, 'expected ExpressionScan in the noRead list');
        assert.ok(code.indexOf("op === 'ExpressionScan'") > -1, 'expected ExpressionScan among the source operators');
    });
});
