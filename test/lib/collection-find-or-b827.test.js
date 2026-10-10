'use strict';
/**
 * #B827 — `Collection.find()` lists a row once, whatever the number of filter
 * objects it matches.
 *
 * Several filter objects are an OR clause: a row is in the result when it
 * matches at least one of them. The match block used to list the row inside
 * the loop over the filter objects, and the guards meant to skip a row already
 * listed looked a `_uuid` STRING up in an array of ROW OBJECTS, which never
 * finds anything. A row matching two filters was therefore listed twice (the
 * same object, twice), a row matching three filters three times: `limit(n)` on
 * such a result pushed a real row out, and a chained call met the row twice.
 *
 * The row is now listed once and the remaining filters are not read for it.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — a row matching several filters (fix-sensitive)
 *  03 — what the second copy did downstream (fix-sensitive)
 *  04 — source pin (comment-stripped): the match block lists once and leaves the filter loop
 *  05 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `7c12f8c7f` before the fix. The ten arms
 * marked « control » held; the fifteen others were red, each on its own
 * assertion (an extra copy of a row, or the old lookup still in the text).
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

// Rows `a` and `b` share `g: 'x'`; every row has `v: 0`.
var NO_ID   = [{ g: 'x', name: 'a', v: 0 }, { g: 'x', name: 'b', v: 0 }, { g: 'y', name: 'c', v: 0 }];
var WITH_ID = [{ id: 1, g: 'x', name: 'a', v: 0 }, { id: 2, g: 'x', name: 'b', v: 0 }, { id: 3, g: 'y', name: 'c', v: 0 }];

/**
 * A fresh Collection over a deep copy of `rows`.
 *
 * @inner
 * @param {Array} rows
 * @returns {Array} the Collection instance
 */
function mk(rows) {
    return new Collection(JSON.parse(JSON.stringify(rows)));
}

/**
 * Each row as `name/v`, in slot order.
 *
 * @inner
 * @param {Array} rows
 * @returns {string[]}
 */
function nv(rows) {
    return Array.prototype.map.call(rows, function (x) {
        return x.name + '/' + x.v;
    });
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
 * The text of find()'s definition, up to findOne()'s.
 *
 * @inner
 * @param {string} s - source or bundle text
 * @returns {string|null}
 */
function findBlock(s) {
    var start = s.indexOf("instance['find'] = function");
    if (start < 0) return null;
    var end = s.indexOf("instance['findOne'] = function", start);
    return end < 0 ? null : s.slice(start, end);
}

// The match block once fixed: the row is listed, then the filter loop is left.
var LISTS_ONCE  = /if \(matched == condition \) \{[^\n]*\n\s*result\[i\] = tmpContent\[o\];\s*\+\+i;\s*break;\s*\}/;
// The lookup the old guards made: a `_uuid` searched in the array of rows.
var OLD_LOOKUP  = 'result.indexOf(tmpContent[o]._uuid)';

// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B827: controls (hold before and after the fix)', function () {

    it('01.1  control: one filter lists each matching row once', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ g: 'x' })), ['a/0', 'b/0']);
    });

    it('01.2  control: two filters that no row matches together list each row once', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { name: 'c' })), ['a/0', 'c/0']);
    });

    it('01.3  control: two filters on the same key with different values', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ g: 'x' }, { g: 'y' })), ['a/0', 'b/0', 'c/0']);
    });

    it('01.4  control: the rows come in collection order, not in filter order', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ g: 'y' }, { name: 'a' })), ['a/0', 'c/0']);
    });

    it('01.5  control: findOne() with two filters returns the first matching row', function () {
        assert.equal(mk(NO_ID).findOne({ name: 'a' }, { g: 'x' }).name, 'a');
    });

    it('01.6  control: delete() and notIn() with two filters remove every row matching either', function () {
        assert.deepEqual(nv(mk(NO_ID).delete({ name: 'a' }, { g: 'x' })), ['c/0']);
        assert.deepEqual(nv(mk(NO_ID).notIn({ name: 'a' }, { g: 'x' })), ['c/0']);
    });

    it('01.7  control: or().find() with one filter', function () {
        assert.deepEqual(nv(mk(NO_ID).or().find({ g: 'x' })), ['a/0', 'b/0']);
    });

    it('01.8  control: a listed row is the collection\'s own row', function () {
        var col = mk(NO_ID);
        assert.equal(col.find({ name: 'a' }, { g: 'x' })[0], col[0]);
    });
});

// ─── 02 — a row matching several filters ──────────────────────────────────────

describe('02 - #B827: a row matching several filters is listed once', function () {

    it('02.1  two filters, row `a` matches both', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { g: 'x' })), ['a/0', 'b/0']);
    });

    it('02.2  the result holds each row object once', function () {
        var found = mk(NO_ID).find({ name: 'a' }, { g: 'x' });
        assert.equal(found.length, 2);
        assert.notEqual(found[0], found[1]);
    });

    it('02.3  or().find() with two filters', function () {
        assert.deepEqual(nv(mk(NO_ID).or().find({ name: 'a' }, { g: 'x' })), ['a/0', 'b/0']);
    });

    it('02.4  three filters, one of them matching every row', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { g: 'x' }, { v: 0 })), ['a/0', 'b/0', 'c/0']);
    });

    it('02.5  the same filter given twice', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ g: 'x' }, { g: 'x' })), ['a/0', 'b/0']);
    });

    it('02.6  on a chained result', function () {
        assert.deepEqual(nv(mk(NO_ID).find({}).find({ name: 'a' }, { g: 'x' })), ['a/0', 'b/0']);
    });

    it('02.7  rows that carry an `id`', function () {
        assert.deepEqual(nv(mk(WITH_ID).find({ id: 1 }, { g: 'x' })), ['a/0', 'b/0']);
    });
});

// ─── 03 — downstream ──────────────────────────────────────────────────────────

describe('03 - #B827: the calls chained on a two-filter result', function () {

    it('03.1  limit(2) keeps the two rows found', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { g: 'x' }).limit(2)), ['a/0', 'b/0']);
    });

    it('03.2  update() returns each row found once, updated', function () {
        assert.deepEqual(nv(mk(WITH_ID).find({ name: 'a' }, { g: 'x' }).update({ id: 'not null' }, { v: 1 })), ['a/1', 'b/1']);
    });

    it('03.3  toRaw() returns the two rows found', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { g: 'x' }).toRaw()), ['a/0', 'b/0']);
    });

    it('03.4  orderBy() sorts the two rows found', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ name: 'a' }, { g: 'x' }).orderBy({ name: 'desc' })), ['b/0', 'a/0']);
    });

    it('03.5  filter(fn) meets each row found once', function () {
        var seen = [];
        mk(NO_ID).find({ name: 'a' }, { g: 'x' }).filter(function (row) { seen.push(row.name); return true; });
        assert.deepEqual(seen, ['a', 'b']);
    });
});

// ─── 04 — source pin ──────────────────────────────────────────────────────────

describe('04 - #B827: source — find() lists a matched row once', function () {
    var raw   = fs.readFileSync(SRC, 'utf8');
    var block = findBlock(raw);
    var live  = block ? stripComments(block) : null;

    it('04.1  control: find() is found, and the strip keeps its live code', function () {
        assert.ok(block, "instance['find'] must be found in " + SRC);
        assert.ok(live.indexOf('if (matched == condition )') > -1, 'the strip must keep the match test');
    });

    it('04.2  live code lists the row, then leaves the filter loop', function () {
        assert.ok(LISTS_ONCE.test(live), 'the match block must list the row once and break');
    });

    it('04.3  live code no longer looks a `_uuid` up in the array of rows', function () {
        assert.equal(live.indexOf(OLD_LOOKUP), -1, 'the old lookup must be gone');
    });
});

// ─── 05 — dist pin ────────────────────────────────────────────────────────────

describe('05 - #B827: the browser bundle carries the fix', function () {
    var dist  = fs.existsSync(DIST_JS) ? fs.readFileSync(DIST_JS, 'utf8') : null;
    var block = dist ? findBlock(dist) : null;

    it('05.1  control: the unminified bundle carries find()', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(block, "the bundle must carry instance['find']");
        assert.ok(stripComments(block).indexOf('if (matched == condition )') > -1, 'the bundle must carry the match test');
    });

    it('05.2  the bundle lists the row once and no longer carries the old lookup', function () {
        var live = stripComments(block);
        assert.ok(LISTS_ONCE.test(live), 'the bundle must list the row once and break');
        assert.equal(live.indexOf(OLD_LOOKUP), -1, 'the bundle must not carry the old lookup');
    });
});
