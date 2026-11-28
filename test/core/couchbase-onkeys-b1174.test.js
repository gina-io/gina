'use strict';
/**
 * #B1174 — the Couchbase plan walker did not label a key-based JOIN or NEST (`… ON KEYS`).
 *
 * The dev Inspector's index badge for a Couchbase statement comes from its EXPLAIN plan. Measured
 * on Couchbase 8.0.2: a FROM over an expression that feeds `JOIN … ON KEYS` plans as an
 * `ExpressionScan` followed by a `Join` operator carrying `on_keys` (the keyspace and the alias beside
 * it); `NEST … ON KEYS` plans the same way with a `Nest` operator. `extractIndexes` labelled neither
 * operator, so such a statement, which reads the joined keyspace by key, reported `[]` and showed the
 * red « no index » badge; an ON KEYS join from a keyspace showed only the index of its left side.
 * Fix: a `Join` or a `Nest` carrying `on_keys` adds one « KV lookup (ON KEYS) » entry, as a `KeyScan`
 * adds the « KV lookup (USE KEYS) » one.
 *
 * §01 runs the connector's own functions, lifted from its source by brace counting as
 * inspector.test.js §30 and §92 and couchbase-expressionscan-b1162.test.js do, on the two plans
 * measured on 8.0.2 (names neutralized) and on rows built from them; §02 pins the source. Red-first:
 * GINA_B1174_CONNECTOR_SRC=<pre-fix connector> reds §01.2–§01.6, §01.8 and §02.1; §00.1, §01.1
 * (USE KEYS) and §01.7 (a Join without on_keys), the controls, pass on both.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var commentStrip = require('../strip-comments');
var SOURCE = process.env.GINA_B1174_CONNECTOR_SRC || path.join(FW, 'core', 'connectors', 'couchbase', 'index.js');
var RAW = fs.readFileSync(SOURCE, 'utf8');
// Every comment out, by the exact strip (test/strip-comments.js): the pins read code only
var CODE = commentStrip.all(RAW);

var ON_KEYS  = 'KV lookup (ON KEYS)';
var USE_KEYS = 'KV lookup (USE KEYS)';

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

// -- EXPLAIN plans measured on Couchbase 8.0.2 (keyspace, alias and key expression neutralized) --

// SELECT d.k FROM [ "k1" ] AS x JOIN sample AS d ON KEYS x
function joinOnKeysPlan() {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'ExpressionScan', alias: 'x', expr: '["k1"]', uncorrelated: true },
        { '#operator': 'Join', as: 'd', keyspace: 'sample', namespace: 'default', on_keys: '`x`' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'InitialProject', result_terms: [ { expr: '(`d`.`k`)' } ] }
        ] } }
    ] };
}

// SELECT x, ds FROM [ "k1" ] AS x NEST sample AS ds ON KEYS x
function nestOnKeysPlan() {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'ExpressionScan', alias: 'x', expr: '["k1"]', uncorrelated: true },
        { '#operator': 'Nest', as: 'ds', keyspace: 'sample', namespace: 'default', on_keys: '`x`' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'InitialProject', result_terms: [ { expr: '`x`' }, { expr: '`ds`' } ] }
        ] } }
    ] };
}

// SELECT RAW META(t).id FROM sample AS t USE KEYS "k1"
function useKeysPlan() {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'KeyScan', keys: '"k1"' },
        { '#operator': 'Fetch', as: 't', keyspace: 'sample', namespace: 'default' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'InitialProject', raw: true, result_terms: [ { expr: '(meta(`t`).`id`)' } ] }
        ] } }
    ] };
}

// -- plans built from them --

// an indexed read of the left side, then a key-based join
function indexedJoinPlan(name) {
    return { '#operator': 'Sequence', '~children': [
        { '#operator': 'IndexScan3', index: name, keyspace: 'sample', namespace: 'default', using: 'gsi' },
        { '#operator': 'Fetch', as: 't', keyspace: 'sample', namespace: 'default' },
        { '#operator': 'Join', as: 'd', keyspace: 'other', namespace: 'default', on_keys: '(`t`.`ref`)' },
        { '#operator': 'Parallel', '~child': { '#operator': 'Sequence', '~children': [
            { '#operator': 'Filter' }, { '#operator': 'InitialProject' }
        ] } }
    ] };
}


describe('00 - the connector\'s walker functions are lifted from its source', function () {

    it('00.1  extractIndexes and extractExplainIndexes are found and compile', function () {
        assert.ok(EXTRACT_SRC.length > 0, 'expected var extractIndexes = function(profile) in the couchbase connector');
        assert.ok(EXPLAIN_SRC.length > 0, 'expected var extractExplainIndexes = function(row) in the couchbase connector');
        assert.equal(liftError, null, 'the lifted functions do not compile: ' + liftError);
    });
});


describe('01 - a key-based JOIN or NEST reports « KV lookup (ON KEYS) »', function () {

    it('01.1  CONTROL: a USE KEYS read reports « KV lookup (USE KEYS) » alone', function () {
        assert.deepEqual(names(walk({ plan: useKeysPlan() })), [ USE_KEYS ]);
    });

    it('01.2  a FROM over an expression feeding JOIN … ON KEYS reports the ON KEYS lookup, not []', function () {
        assert.deepEqual(walk({ plan: joinOnKeysPlan() }), [ { name: ON_KEYS, primary: false } ]);
    });

    it('01.3  a FROM over an expression feeding NEST … ON KEYS reports the ON KEYS lookup, not []', function () {
        assert.deepEqual(walk({ plan: nestOnKeysPlan() }), [ { name: ON_KEYS, primary: false } ]);
    });

    it('01.4  an ON KEYS join from an indexed keyspace reports its index and the ON KEYS lookup', function () {
        assert.deepEqual(names(walk({ plan: indexedJoinPlan('idx_a') })), [ 'idx_a', ON_KEYS ]);
    });

    it('01.5  a USE KEYS read joined ON KEYS reports both lookups, each once', function () {
        var plan = useKeysPlan();
        plan['~children'].splice(2, 0, { '#operator': 'Join', as: 'd', keyspace: 'other', namespace: 'default', on_keys: '(`t`.`ref`)' });
        assert.deepEqual(names(walk({ plan: plan })), [ USE_KEYS, ON_KEYS ]);
    });

    it('01.6  two ON KEYS operators in one plan report the ON KEYS lookup once', function () {
        var plan = joinOnKeysPlan();
        plan['~children'].splice(2, 0, { '#operator': 'Nest', as: 'ds', keyspace: 'other', namespace: 'default', on_keys: '(`d`.`refs`)' });
        assert.deepEqual(names(walk({ plan: plan })), [ ON_KEYS ]);
    });

    it('01.7  CONTROL: a Join without on_keys (a shape not measured) adds nothing, so the plan keeps the plain []', function () {
        var plan = joinOnKeysPlan();
        delete plan['~children'][1].on_keys;
        assert.deepEqual(walk({ plan: plan }), []);
    });

    it('01.8  the meta.profile path (extractIndexes on executionTimings) labels an ON KEYS join too', function () {
        assert.deepEqual(names(fns.extractIndexes({ executionTimings: joinOnKeysPlan() })), [ ON_KEYS ]);
    });
});


describe('02 - source pins: the fix cannot be silently reverted', function () {

    it('02.1  extractIndexes labels a Join or a Nest carrying on_keys as « KV lookup (ON KEYS) »', function () {
        var code = sliceFn(CODE, 'var extractIndexes = function(profile)');
        assert.ok(code.length > 0, 'expected extractIndexes in the comment-stripped source');
        assert.ok(code.indexOf("(op === 'Join' || op === 'Nest') && typeof(node.on_keys) === 'string'") > -1,
            'expected the Join / Nest + on_keys test in extractIndexes');
        assert.ok(code.indexOf("name    : 'KV lookup (ON KEYS)'") > -1, 'expected the ON KEYS label in extractIndexes');
        // strip control: the raw function names #B1174 in its comment, the stripped code does not
        assert.ok(EXTRACT_SRC.indexOf('#B1174') > -1, 'strip control: the raw extractIndexes names #B1174');
        assert.equal(code.indexOf('#B1174'), -1, 'strip control: the comment-stripped extractIndexes has no #B1174');
    });
});
