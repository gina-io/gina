'use strict';
/**
 * #B1029 — `Collection.notIn()` (and `delete()`, which delegates to it) on an
 * EMPTY source returns an empty result.
 *
 * `notIn(rows, key)` returns a copy of the searched rows without the rows
 * found. When the searched array was empty — a new Collection over `[]`, or an
 * empty query result chained into `notIn` — a branch returned the rows found
 * instead: the very rows `notIn` excludes, none of which belong to the source.
 * The no-key form, the `false` form and `delete(rows, key)` came back the same
 * way. An empty source has no row to keep, so the result is now `[]`.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — an empty source returns `[]` (fix-sensitive)
 *  03 — source pin (comment-stripped): the branch no longer returns the rows found
 *  04 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against `c91fbf88f` (develop, before this fix). The arms
 * marked « control » held; the others were red, each on its own assertion
 * (the excluded rows returned, or the text still live).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SRC        = path.join(FW, 'lib/collection/src/main.js');
var DIST_JS    = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

require(path.join(FW, '../../utils/prototypes'));    // JSON.clone, count()
var Collection = require(path.join(FW, 'lib/collection'));

// Rows that come from elsewhere: the ones `notIn` must exclude.
var EXCLUDED = [{ id: 'x', status: 'rejected' }, { id: 'y', status: 'draft' }];

/**
 * A deep copy of the rows to exclude, so no arm can see another's mutation.
 *
 * @inner
 * @returns {Array}
 */
function excluded() {
    return JSON.parse(JSON.stringify(EXCLUDED));
}

/**
 * A result's rows without the collection's internal fields.
 *
 * @inner
 * @param {Array} result - a query result (chainable Array)
 * @returns {Array}
 */
function rows(result) {
    return JSON.parse(JSON.stringify(result.toRaw()));
}

/**
 * Removes block comments and whole-line `//` comments.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/**
 * The text of notIn()'s definition, up to insert()'s.
 *
 * @inner
 * @param {string} s - source or bundle text
 * @returns {string|null}
 */
function notInBlock(s) {
    var start = s.indexOf("instance['notIn'] =");
    if (start < 0) return null;
    var end = s.indexOf("instance['insert'] = function", start);
    return end < 0 ? null : s.slice(start, end);
}

// The empty-source branch handed back the rows found as the result.
var RETURNS_FOUND = 'currentResult = JSON.clone(foundResults);';
// The branch itself, kept for the comment-stripped pins to anchor on.
var EMPTY_BRANCH  = "} else if ( typeof(currentResult[c]) == 'undefined' ) {";

// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B1029: controls (hold before and after the fix)', function () {

    it('01.1  control: a source row that is not excluded survives', function () {
        var result = new Collection([{ id: 'a' }]).notIn(excluded(), 'id');
        assert.deepEqual(rows(result), [{ id: 'a' }]);
    });

    it('01.2  control: a source row that is excluded is taken out', function () {
        var result = new Collection([{ id: 'x' }, { id: 'a' }]).notIn(excluded(), 'id');
        assert.deepEqual(rows(result), [{ id: 'a' }]);
    });

    it('01.3  control: the filter-object form on an empty source returns []', function () {
        var result = new Collection([]).notIn({ id: 'x' });
        assert.deepEqual(rows(result), []);
    });

    it('01.4  control: an empty exclusion list leaves a non-empty source whole', function () {
        var result = new Collection([{ id: 'a' }, { id: 'b' }]).notIn([], 'id');
        assert.deepEqual(rows(result), [{ id: 'a' }, { id: 'b' }]);
    });

    it('01.5  control: foreign rows with no usable key are still refused', function () {
        assert.throws(function () {
            new Collection([]).notIn([{ name: 'x' }]);
        }, /No comparison key defined !/);
    });
});

// ─── 02 — an empty source returns [] ─────────────────────────────────────────

describe('02 - #B1029: an empty source returns an empty result', function () {

    it('02.1  notIn(rows, key) on an empty Collection returns []', function () {
        var result = new Collection([]).notIn(excluded(), 'id');
        assert.deepEqual(rows(result), []);
    });

    it('02.2  notIn(rows) with no key returns []', function () {
        var result = new Collection([]).notIn(excluded());
        assert.deepEqual(rows(result), []);
    });

    it('02.3  notIn(rows, false) returns []', function () {
        var result = new Collection([]).notIn(excluded(), false);
        assert.deepEqual(rows(result), []);
    });

    it('02.4  an empty query result chained into notIn(rows, key) returns []', function () {
        var result = new Collection([{ id: 'a' }]).find({ id: 'none' }).notIn(excluded(), 'id');
        assert.deepEqual(rows(result), []);
    });

    it('02.5  delete(rows, key) on an empty Collection returns []', function () {
        var result = new Collection([]).delete(excluded(), 'id');
        assert.deepEqual(rows(result), []);
    });

    it('02.6  the empty result stays chainable and leaves the excluded rows untouched', function () {
        var list   = excluded();
        var result = new Collection([]).notIn(list, 'id');
        assert.equal(result.length, 0);
        assert.equal(typeof result.toRaw, 'function', 'the result must stay chainable');
        assert.equal(typeof result.find, 'function', 'the result must stay chainable');
        assert.deepEqual(list, EXCLUDED, 'the rows passed in must not change');
    });
});

// ─── 03 — source pin ──────────────────────────────────────────────────────────

describe('03 - #B1029: source — the empty-source branch no longer returns the rows found', function () {
    var raw   = fs.readFileSync(SRC, 'utf8');
    var block = notInBlock(raw);
    var live  = block ? stripComments(block) : null;

    it('03.1  control: notIn() is found, and the strip keeps its live code', function () {
        assert.ok(block, "instance['notIn'] must be found in " + SRC);
        assert.ok(live.indexOf('instance.find.apply(this, arguments)') > -1, 'the strip must keep the find() call');
        assert.ok(live.indexOf(EMPTY_BRANCH) > -1, 'the strip must keep the empty-source branch');
    });

    it('03.2  the old assignment is no longer live code (kept only as a comment)', function () {
        assert.ok(block.indexOf(RETURNS_FOUND) > -1, 'the raw block must still name the old assignment, or the strip cannot be checked');
        assert.equal(live.indexOf(RETURNS_FOUND), -1, 'the empty-source branch must not return the rows found');
    });
});

// ─── 04 — dist pin ────────────────────────────────────────────────────────────

describe('04 - #B1029: the browser bundle carries the fix', function () {
    var dist  = fs.existsSync(DIST_JS) ? fs.readFileSync(DIST_JS, 'utf8') : null;
    var block = dist ? notInBlock(dist) : null;

    it('04.1  control: the unminified bundle carries notIn() and its empty-source branch', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(block, "the bundle must carry instance['notIn']");
        assert.ok(stripComments(block).indexOf(EMPTY_BRANCH) > -1, 'the bundle must carry the empty-source branch');
    });

    it('04.2  the bundle no longer returns the rows found on an empty source', function () {
        assert.equal(stripComments(block).indexOf(RETURNS_FOUND), -1, 'the bundle must not return the rows found');
    });
});
