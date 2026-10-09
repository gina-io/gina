'use strict';
/**
 * #B822 — `Collection.update()` writes each matched row back in its own place.
 *
 * `update(filter, set)` merges `set` into every row `filter` matches, then
 * writes each merged row back over the row it came from. It used to find that
 * place by comparing a key on each stored row with the same key on the merged
 * row: the internal `_uuid` by default, `id` when the stored row had no
 * `_uuid` but had an `id`. On a collection and on a chained result, the
 * matched rows ARE the stored rows, and `toRaw()` strips their `_uuid` in
 * place before the comparison. Two rows carrying no `id` then compared
 * `undefined == undefined`: every matched row overwrote the FIRST stripped
 * row, so one row was lost, another appeared twice, and the rest were not
 * updated, with no error. The same happened to a SINGLE matched row once an
 * earlier `update()` or `toRaw()` had stripped a row before it, and a row
 * matched through another collection's result was not written at all.
 *
 * The place is now found by identity first (the matched row is the stored
 * row), otherwise by a key both rows carry — the explicit `key`, else
 * `_uuid`, else `id` — and never by a key one of them lacks. A place already
 * written by the call is not written again, and a row matched twice is
 * written once.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — several matched rows with no `id` (fix-sensitive)
 *  03 — one matched row after an earlier write stripped another (fix-sensitive)
 *  04 — the other call forms (fix-sensitive)
 *  05 — source pin (comment-stripped): update() locates the row by identity
 *  06 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `e1a4818b4` before the fix. Suite 01 and the
 * arm marked « control » held (8); every other arm was red (19). Arm 03.3 was
 * added after the fix landed and measured red on those same bytes.
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

// Rows with no `id`: two share `g: 'x'`.
var NO_ID   = [{ g: 'x', name: 'a', v: 0 }, { g: 'x', name: 'b', v: 0 }, { g: 'y', name: 'c', v: 0 }];
var WITH_ID = [{ id: 1, g: 'x', name: 'a', v: 0 }, { id: 2, g: 'x', name: 'b', v: 0 }, { id: 3, g: 'y', name: 'c', v: 0 }];
// Rows that arrive with their own `_uuid` (the collection keeps it).
var OWN_UUID = [{ _uuid: 'u1', g: 'x', name: 'a', v: 0 }, { _uuid: 'u2', g: 'x', name: 'b', v: 0 }, { _uuid: 'u3', g: 'y', name: 'c', v: 0 }];

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
 * Each row as `name/v`, plus `#id` when the row has an `id`, in slot order.
 *
 * @inner
 * @param {Array} rows
 * @returns {string[]}
 */
function nv(rows) {
    return Array.prototype.map.call(rows, function (x) {
        return x.name + '/' + x.v + (typeof(x.id) != 'undefined' ? '#' + x.id : '');
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
 * The text of update()'s definition, up to the next method's documentation.
 *
 * @inner
 * @param {string} s - source or bundle text
 * @returns {string|null}
 */
function updateBlock(s) {
    var start = s.indexOf("instance['update'] = function");
    if (start < 0) return null;
    var end = s.indexOf("instance['replace'] = function", start);
    return end < 0 ? null : s.slice(start, end);
}

// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B822: controls (hold before and after the fix)', function () {

    it('01.1  one matched row on a fresh collection is updated in place', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ name: 'b' }, { v: 1 }).toRaw()), ['a/0', 'b/1', 'c/0']);
    });

    it('01.2  two matched rows that carry an `id` are both updated', function () {
        assert.deepEqual(nv(mk(WITH_ID).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1#1', 'b/1#2', 'c/0#3']);
    });

    it('01.3  two matched rows that carry their own `_uuid` are both updated', function () {
        assert.deepEqual(nv(mk(OWN_UUID).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('01.4  rows with their own `_uuid`, updated twice on the same collection', function () {
        var c = mk(OWN_UUID);
        c.update({ g: 'x' }, { v: 1 });
        c.update({ name: 'a' }, { v: 2 });
        assert.deepEqual(nv(c.toRaw()), ['a/2', 'b/1', 'c/0']);
    });

    it('01.5  `set` wins on the fields it names, rows with an `id`', function () {
        var rows = mk(WITH_ID).update({ g: 'x' }, { g: 'z', v: 1 }).toRaw();
        assert.deepEqual(rows.map(function (x) { return x.name + '/' + x.v + '/' + x.g; }), ['a/1/z', 'b/1/z', 'c/0/y']);
    });

    it('01.6  no matched row: nothing changes', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ g: 'none' }, { v: 1 }).toRaw()), ['a/0', 'b/0', 'c/0']);
    });

    it('01.7  the same row with no `id` updated twice (its own stripped place is the first one)', function () {
        var c = mk(NO_ID);
        c.update({ name: 'b' }, { v: 1 });
        c.update({ name: 'b' }, { v: 2 });
        assert.deepEqual(nv(c.toRaw()), ['a/0', 'b/2', 'c/0']);
    });
});

// ─── 02 — several matched rows with no `id` ───────────────────────────────────

describe('02 - #B822: several matched rows with no `id` are each written in their own place', function () {

    it('02.1  two matched rows, read through toRaw()', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('02.2  two matched rows, read on the chained result', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ g: 'x' }, { v: 1 })), ['a/1', 'b/1', 'c/0']);
    });

    it('02.3  the collection itself after the call', function () {
        var c = mk(NO_ID);
        c.update({ g: 'x' }, { v: 1 });
        assert.deepEqual(nv(c.toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('02.4  three matched rows', function () {
        var rows = [{ g: 'x', name: 'a', v: 0 }, { g: 'x', name: 'b', v: 0 }, { g: 'y', name: 'c', v: 0 }, { g: 'x', name: 'd', v: 0 }];
        assert.deepEqual(nv(mk(rows).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/0', 'd/1']);
    });

    it('02.5  an empty filter updates every row', function () {
        assert.deepEqual(nv(mk(NO_ID).update({}, { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/1']);
    });

    it('02.6  `set` changes the field the filter matched on', function () {
        var rows = mk(NO_ID).update({ g: 'x' }, { g: 'z', v: 1 }).toRaw();
        assert.deepEqual(rows.map(function (x) { return x.name + '/' + x.v + '/' + x.g; }), ['a/1/z', 'b/1/z', 'c/0/y']);
    });

    it('02.7  a row matched by two filter objects is written once', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ name: 'a' }, { g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('02.8  the row count is unchanged and no row appears twice', function () {
        var rows = mk(NO_ID).update({ g: 'x' }, { v: 1 }).toRaw();
        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map(function (x) { return x.name; }).sort(), ['a', 'b', 'c']);
    });
});

// ─── 03 — one matched row after an earlier write ──────────────────────────────

describe('03 - #B822: one matched row is written in its own place after an earlier write', function () {

    it('03.1  two single-row updates on the same collection', function () {
        var c = mk(NO_ID);
        c.update({ name: 'a' }, { v: 1 });
        c.update({ name: 'b' }, { v: 2 });
        assert.deepEqual(nv(c.toRaw()), ['a/1', 'b/2', 'c/0']);
    });

    it('03.2  toRaw() on the collection, then one single-row update', function () {
        var c = mk(NO_ID);
        c.toRaw();
        c.update({ name: 'b' }, { v: 1 });
        assert.deepEqual(nv(c.toRaw()), ['a/0', 'b/1', 'c/0']);
    });

    it('03.3  rows with their own `_uuid`: toRaw() twice drops it, then one single-row update', function () {
        // toRaw() keeps a `_uuid` the row arrived with the first time it runs on
        // the row, and drops it the second time.
        var c = mk(OWN_UUID);
        c.toRaw();
        c.toRaw();
        c.update({ name: 'b' }, { v: 1 });
        assert.deepEqual(nv(c.toRaw()), ['a/0', 'b/1', 'c/0']);
    });
});

// ─── 04 — the other call forms ────────────────────────────────────────────────

describe('04 - #B822: the other call forms write each matched row in its own place', function () {

    it('04.1  a result of find() passed as the first argument', function () {
        var c = mk(NO_ID);
        assert.deepEqual(nv(c.update(c.find({ g: 'x' }), { v: 1 }).toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('04.2  find().update() on the chained result', function () {
        assert.deepEqual(nv(mk(NO_ID).find({ g: 'x' }).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1']);
    });

    it('04.3  a row with no `id` before a row with one', function () {
        var rows = [{ g: 'x', name: 'a', v: 0 }, { id: 2, g: 'x', name: 'b', v: 0 }, { g: 'y', name: 'c', v: 0 }];
        assert.deepEqual(nv(mk(rows).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1', 'b/1#2', 'c/0']);
    });

    it('04.4  an explicit `id` key on rows that have no `id`', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ g: 'x' }, { v: 1 }, 'id').toRaw()), ['a/1', 'b/1', 'c/0']);
    });

    it('04.5  two rows sharing the same `id`', function () {
        var rows = [{ id: 1, g: 'x', name: 'a', v: 0 }, { id: 1, g: 'x', name: 'b', v: 0 }, { id: 3, g: 'y', name: 'c', v: 0 }];
        assert.deepEqual(nv(mk(rows).update({ g: 'x' }, { v: 1 }).toRaw()), ['a/1#1', 'b/1#1', 'c/0#3']);
    });

    it('04.6  rows found by another collection over the same rows are written by `id`', function () {
        var A = mk(WITH_ID), B = mk(WITH_ID);
        assert.deepEqual(nv(A.update(B.find({ g: 'x' }), { v: 1 }).toRaw()), ['a/1#1', 'b/1#2', 'c/0#3']);
    });
});

// ─── 05 — source pin ──────────────────────────────────────────────────────────

describe('05 - #B822: source — update() finds the place by identity first', function () {
    var raw   = fs.readFileSync(SRC, 'utf8');
    var block = updateBlock(raw);
    var live  = block ? stripComments(block) : null;

    it('05.1  control: update() is found, and the strip keeps its live code', function () {
        assert.ok(block, "instance['update'] must be found in " + SRC);
        assert.ok(live.indexOf('foundResults.toRaw()') > -1, 'the strip must keep the toRaw() call');
    });

    it('05.2  live code compares the stored row with the matched row by identity', function () {
        assert.ok(live.indexOf('result[r] === found[a]') > -1, 'the identity check must be live code');
    });

    it('05.3  live code no longer compares a key on the merged row', function () {
        assert.equal(live.indexOf('result[r][key] == arr[a][key]'), -1, 'the merged-row key comparison must be gone');
    });
});

// ─── 06 — dist pin ────────────────────────────────────────────────────────────

describe('06 - #B822: the browser bundle carries the fix', function () {
    var dist  = fs.existsSync(DIST_JS) ? fs.readFileSync(DIST_JS, 'utf8') : null;
    var block = dist ? updateBlock(dist) : null;

    it('06.1  the unminified bundle carries update() (control) with the identity check', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(block, "the bundle must carry instance['update']");
        var live = stripComments(block);
        assert.ok(live.indexOf('result[r] === found[a]') > -1, 'the bundle must carry the identity check');
        assert.equal(live.indexOf('result[r][key] == arr[a][key]'), -1, 'the bundle must not carry the merged-row key comparison');
    });
});
