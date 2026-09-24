/**
 * #B609 — lib/collection operator filters on STRING values.
 *
 * Before the fix, `find`/`searchThroughProp` built the comparison expression by
 * quoting the operands with `"` + value + `"` (or, in the nested path, no quoting
 * at all) and feeding it to the safe evaluator, whose string operand grammar was
 * `"[^"]*"`. Consequences, all measured through the public API:
 *   1. a `"` in ANY row's string value threw and poisoned the whole query;
 *   2. a `"` in the filter value threw likewise;
 *   3. `==`, `>`, `<` on strings ALWAYS threw (the operator-strip regex omitted
 *      them, so the operator leaked into the operand);
 *   4. a space after the operator (`'>= b'`) was kept inside the operand, so
 *      string comparisons returned the wrong rows.
 *
 * The numeric and datetime comparison paths were not changed; the controls below
 * assert they still behave as before. Red-first was verified against the pre-fix
 * bytes (facets 1/2/3 throw, facet 4 wrong; controls identical) before landing.
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');

var FW = require('../fw');
var helpers = require(path.join(FW, 'helpers'));
var Collection = require(path.join(FW, 'lib/collection/src/main'));

/**
 * Extracts one field from every row of a find() result, sorted, so a result set
 * can be compared regardless of order.
 * @inner
 * @param {object} res - the collection returned by find()
 * @param {string} key - field to read from each row
 * @returns {Array} sorted field values
 */
function pluck(res, key) {
    var out = [];
    for (var i = 0; i < res.length; i++) { out.push(res[i][key]); }
    return out.sort();
}

var strRows = [{ name: 'abc' }, { name: 'b' }, { name: 'zz' }];
var numRows = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe('#B609 - string operator filters compare instead of throwing', function () {

    // ── controls: numeric + already-working string operators are unchanged ──
    it('control: numeric >= is unchanged', function () {
        assert.deepEqual(pluck(new Collection(numRows).find({ n: '>=2' }), 'n'), [2, 3]);
    });
    it('control: numeric == is unchanged', function () {
        assert.deepEqual(pluck(new Collection(numRows).find({ n: '==3' }), 'n'), [3]);
    });
    it('control: string >= is unchanged', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '>=b' }), 'name'), ['b', 'zz']);
    });
    it('control: string <= is unchanged', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '<=b' }), 'name'), ['abc', 'b']);
    });

    // ── facet 3: ==, >, < on strings used to throw ──
    it('== on a string value returns the exact match (was: throw)', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '==b' }), 'name'), ['b']);
    });
    it('> on a string value compares lexically (was: throw)', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '>b' }), 'name'), ['zz']);
    });
    it('< on a string value compares lexically (was: throw)', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '<b' }), 'name'), ['abc']);
    });

    // ── facet 4: a space after the operator used to skew the comparison ──
    it('a space after the operator is trimmed (was: wrong rows)', function () {
        assert.deepEqual(pluck(new Collection(strRows).find({ name: '>= b' }), 'name'), ['b', 'zz']);
    });

    // ── facet 1: a quote in a ROW value used to throw and poison the query ──
    it('a double quote in a row value no longer throws; every row is compared', function () {
        var rows = [{ name: 'abc' }, { name: 'b' }, { name: 'zz' }, { name: 'ab"c' }];
        assert.deepEqual(pluck(new Collection(rows).find({ name: '>=a' }), 'name'),
            ['ab"c', 'abc', 'b', 'zz']);
    });
    it('a backslash in a row value no longer throws', function () {
        var rows = [{ name: 'a\\b' }, { name: 'zz' }];
        assert.deepEqual(pluck(new Collection(rows).find({ name: '>=a' }), 'name'), ['a\\b', 'zz']);
    });

    // ── facet 2: a quote in the FILTER value used to throw ──
    it('a double quote in the filter value matches the row that holds it', function () {
        var rows = [{ name: 'a"b' }, { name: 'x' }];
        assert.deepEqual(pluck(new Collection(rows).find({ name: '==a"b' }), 'name'), ['a"b']);
    });

    // ── datetime path preserved ──
    it('control: datetime >= comparison is unchanged', function () {
        var rows = [
            { at: '2026-01-01T00:00:00' },
            { at: '2026-06-01T12:00:00' },
            { at: '2025-01-01T00:00:00' }
        ];
        var res = new Collection(rows).find({ at: '>=2026-01-01T00:00:00' });
        assert.deepEqual(pluck(res, 'at'), ['2026-01-01T00:00:00', '2026-06-01T12:00:00']);
    });

    // ── nested path (searchThroughProp) — the same helper now applies to strings ──
    it('a nested string path compares with == instead of throwing', function () {
        var rows = [
            { reviews: [{ ratings: { Tier: 'gold' } }] },
            { reviews: [{ ratings: { Tier: 'bronze' } }] }
        ];
        assert.equal(new Collection(rows).find({ 'reviews[*].ratings.Tier': '==gold' }).length, 1);
        assert.equal(new Collection(rows).find({ 'reviews[*].ratings.Tier': '>bronze' }).length, 1);
    });
    it('control: a nested numeric path with a space still works', function () {
        var rows = [
            { reviews: [{ ratings: { Cleanliness: 5 } }] },
            { reviews: [{ ratings: { Cleanliness: 3 } }] }
        ];
        assert.equal(new Collection(rows).find({ 'reviews[*].ratings.Cleanliness': '>= 4' }).length, 1);
    });
});
