'use strict';
/**
 * #B826 — `Collection.notIn()` (and `delete()`, which delegates to it) takes
 * the rows it found out by identity.
 *
 * `notIn(filter)` finds the rows matching `filter`, then removes them from a
 * clone of the searched array. It used to locate each one in the clone by
 * comparing a key taken from the FIRST found row: the internal `_uuid`, else
 * `id`. `toRaw()` and `update()` strip the `_uuid` of the collection's own
 * rows, so on rows with no `id` the call then threw `No comparison key
 * defined !`, and on rows sharing an `id` it removed the first row holding
 * that `id` — the wrong one, with no error. The documented no-key form,
 * `delete(filter, false)`, threw the same way on rows with no `id`, because
 * the key check ran before the branch that form was meant to select, and
 * removed nothing for a dotted key.
 *
 * With a filter object the found rows ARE rows of the searched array. When no
 * key is named and every found row is one, each is now taken out of the clone
 * at its own place and no key is read. A key the caller named, and rows that
 * come from elsewhere, keep the key comparison.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — rows with no `id`, after `toRaw()` or `update()` (fix-sensitive)
 *  03 — the documented no-key form (fix-sensitive)
 *  04 — rows sharing an `id` (fix-sensitive)
 *  05 — the array form given the collection's own rows (fix-sensitive)
 *  06 — source pins (comment-stripped): the identity branch, before the key check
 *  07 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against `55d04c5a9` (the #B827 fix, before this one). The
 * sixteen arms marked « control » held; the sixteen others were red, each on
 * its own assertion (the exception, the wrong rows, or the missing text).
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

// Rows with no `id`: `a` and `b` share `g: 'x'`.
var NO_ID     = [{ g: 'x', name: 'a', v: 0 }, { g: 'x', name: 'b', v: 0 }, { g: 'y', name: 'c', v: 0 }];
var WITH_ID   = [{ id: 1, g: 'x', name: 'a', v: 0 }, { id: 2, g: 'x', name: 'b', v: 0 }, { id: 3, g: 'y', name: 'c', v: 0 }];
// Rows that arrive with their own `_uuid` (the collection keeps it through one toRaw()).
var OWN_UUID  = [{ _uuid: 'u1', g: 'x', name: 'a', v: 0 }, { _uuid: 'u2', g: 'x', name: 'b', v: 0 }, { _uuid: 'u3', g: 'y', name: 'c', v: 0 }];
// Rows `x` and `y` share `id: 1`.
var SHARED_ID = [{ id: 1, name: 'x', v: 0 }, { id: 1, name: 'y', v: 0 }, { id: 2, name: 'z', v: 0 }];
// Rows with an `id` and a nested field: `a` and `c` are in city `P`.
var NESTED    = [{ id: 1, name: 'a', v: 0, address: { city: 'P' } }, { id: 2, name: 'b', v: 0, address: { city: 'L' } }, { id: 3, name: 'c', v: 0, address: { city: 'P' } }];

var NO_KEY    = /No comparison key defined !/;

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
 * The names of the functions `rows` carries as own properties, sorted.
 *
 * @inner
 * @param {Array} rows - a Collection result
 * @returns {string[]}
 */
function methods(rows) {
    return Object.getOwnPropertyNames(rows).filter(function (k) { return typeof(rows[k]) == 'function'; }).sort();
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

// Each found row is looked up, as itself, in the searched array.
var IS_OWN_ROW   = 'source.indexOf(foundResults[s]) < 0';
// A found row is taken out of the clone at its own place.
var TAKEN_OUT    = /foundResults\.indexOf\(source\[s\]\) > -1 \) \{\s*currentResult\.splice\(s, 1\);/;
var KEY_REFUSAL  = "throw new Error('No comparison key defined !')";

// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B826: controls (hold before and after the fix)', function () {

    it('01.1  control: delete() on a fresh collection', function () {
        assert.deepEqual(nv(mk(NO_ID).delete({ name: 'b' })), ['a/0', 'c/0']);
    });

    it('01.2  control: rows that carry an `id`, after toRaw()', function () {
        var col = mk(WITH_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'b' })), ['a/0', 'c/0']);
    });

    it('01.3  control: a named key, after toRaw()', function () {
        var col = mk(NO_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'b' }, 'name')), ['a/0', 'c/0']);
    });

    it('01.4  control: the array form with rows from elsewhere and a named key', function () {
        assert.deepEqual(nv(mk(NO_ID).notIn([{ name: 'b' }], 'name')), ['a/0', 'c/0']);
    });

    it('01.5  control: the array form with rows from elsewhere that carry an `id`', function () {
        assert.deepEqual(nv(mk(WITH_ID).notIn([{ id: 2 }])), ['a/0', 'c/0']);
    });

    it('01.6  control: rows from elsewhere with neither an `id` nor a named key are refused', function () {
        assert.throws(function () { mk(NO_ID).notIn([{ name: 'b' }]); }, NO_KEY);
    });

    it('01.7  control: delete() leaves the collection as it was', function () {
        var col = mk(NO_ID);
        col.delete({ name: 'b' });
        assert.deepEqual(nv(col), ['a/0', 'b/0', 'c/0']);
        assert.equal(typeof(col[1]._uuid), 'string');
    });

    it('01.8  control: the rows returned are copies, each with the `_uuid` of the row copied', function () {
        var col = mk(NO_ID), left = col.delete({ name: 'b' });
        assert.notEqual(left[0], col[0]);
        assert.equal(left[0]._uuid, col[0]._uuid);
        assert.equal(left[1]._uuid, col[2]._uuid);
    });

    it('01.9  control: nothing matched, after toRaw()', function () {
        var col = mk(NO_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'zzz' })), ['a/0', 'b/0', 'c/0']);
    });

    it('01.10 control: after update() of one row, delete() of another', function () {
        var col = mk(NO_ID);
        col.update({ name: 'a' }, { v: 1 });
        assert.deepEqual(nv(col.delete({ name: 'b' })), ['a/1', 'c/0']);
    });

    it('01.11 control: the result carries the same methods', function () {
        assert.deepEqual(methods(mk(NO_ID).delete({ name: 'b' })),
            ['delete', 'filter', 'find', 'findOne', 'insert', 'limit', 'max', 'notIn', 'or', 'orderBy', 'replace', 'setSearchOption', 'toRaw', 'update']);
    });

    it('01.12 control: rows sharing an `id`, on a fresh collection', function () {
        assert.deepEqual(nv(mk(SHARED_ID).delete({ name: 'y' })), ['x/0', 'z/0']);
    });

    it('01.13 control: a dotted key in the default mode', function () {
        assert.deepEqual(nv(mk(NESTED).delete({ 'address.city': 'P' })), ['b/0']);
    });

    it('01.14 control: an empty filter removes every row', function () {
        assert.deepEqual(nv(mk(NO_ID).delete({})), []);
    });
});

// ─── 02 — rows with no `id`, after toRaw() or update() ────────────────────────

describe('02 - #B826: rows with no `id`, after toRaw() or update()', function () {

    it('02.1  toRaw(), then delete()', function () {
        var col = mk(NO_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'b' })), ['a/0', 'c/0']);
    });

    it('02.2  update() of a row, then delete() of that row', function () {
        var col = mk(NO_ID);
        col.update({ name: 'a' }, { v: 1 });
        assert.deepEqual(nv(col.delete({ name: 'a' })), ['b/0', 'c/0']);
    });

    it('02.3  toRaw() on a find() result, then delete() on the collection', function () {
        var col = mk(NO_ID);
        col.find({}).toRaw();
        assert.deepEqual(nv(col.delete({ name: 'b' })), ['a/0', 'c/0']);
    });

    it('02.4  delete() chained on the result of update()', function () {
        assert.deepEqual(nv(mk(NO_ID).update({ name: 'a' }, { v: 1 }).delete({ name: 'a' })), ['b/0', 'c/0']);
    });

    it('02.5  rows with their own `_uuid`, toRaw() twice, then delete()', function () {
        var col = mk(OWN_UUID);
        col.toRaw();
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'b' })), ['a/0', 'c/0']);
    });

    it('02.6  delete() on a chained result whose rows toRaw() stripped', function () {
        var col = mk(NO_ID), found = col.find({ g: 'x' });
        col.toRaw();
        assert.deepEqual(nv(found.delete({ name: 'a' })), ['b/0']);
    });

    it('02.7  two filters, after toRaw()', function () {
        var col = mk(NO_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'a' }, { g: 'y' })), ['b/0']);
    });
});

// ─── 03 — the documented no-key form ──────────────────────────────────────────

describe('03 - #B826: the no-key form, delete(filter, false)', function () {

    it('03.1  delete(filter, false) on fresh rows with no `id`', function () {
        assert.deepEqual(nv(mk(NO_ID).delete({ name: 'b' }, false)), ['a/0', 'c/0']);
    });

    it('03.2  notIn(filter, false) on fresh rows with no `id`', function () {
        assert.deepEqual(nv(mk(NO_ID).notIn({ name: 'b' }, false)), ['a/0', 'c/0']);
    });

    it('03.3  delete(filter, false) with a dotted key removes the rows found', function () {
        assert.deepEqual(nv(mk(NESTED).delete({ 'address.city': 'P' }, false)), ['b/0']);
    });
});

// ─── 04 — rows sharing an `id` ────────────────────────────────────────────────

describe('04 - #B826: rows sharing an `id`', function () {

    it('04.1  after toRaw(), delete() removes the row found, not the first row holding its `id`', function () {
        var col = mk(SHARED_ID);
        col.toRaw();
        assert.deepEqual(nv(col.delete({ name: 'y' })), ['x/0', 'z/0']);
    });
});

// ─── 05 — the array form given the collection's own rows ──────────────────────

describe('05 - #B826: the array form given the collection\'s own rows', function () {

    it('05.1  notIn(found) after toRaw() stripped those rows', function () {
        var col = mk(NO_ID), found = col.find({ name: 'b' });
        col.toRaw();
        assert.deepEqual(nv(col.notIn(found)), ['a/0', 'c/0']);
    });
});

// ─── 06 — source pins ─────────────────────────────────────────────────────────

describe('06 - #B826: source — notIn() takes its own rows out by identity', function () {
    var raw   = fs.readFileSync(SRC, 'utf8');
    var block = notInBlock(raw);
    var live  = block ? stripComments(block) : null;

    it('06.1  control: notIn() is found, and the strip keeps its live code', function () {
        assert.ok(block, "instance['notIn'] must be found in " + SRC);
        assert.ok(live.indexOf('instance.find.apply(this, arguments)') > -1, 'the strip must keep the find() call');
        assert.ok(live.indexOf(KEY_REFUSAL) > -1, 'the strip must keep the key refusal');
    });

    it('06.2  live code looks each found row up, as itself, in the searched array', function () {
        assert.ok(live.indexOf(IS_OWN_ROW) > -1, 'the own-row test must be live code');
    });

    it('06.3  live code takes a found row out of the clone at its own place', function () {
        assert.ok(TAKEN_OUT.test(live), 'the splice by identity must be live code');
    });

    it('06.4  the identity branch stands before the key refusal', function () {
        var branch = live.indexOf('if (byIdentity) {');
        assert.ok(branch > -1, 'the identity branch must be live code');
        assert.ok(branch < live.indexOf(KEY_REFUSAL), 'the identity branch must come first');
    });
});

// ─── 07 — dist pin ────────────────────────────────────────────────────────────

describe('07 - #B826: the browser bundle carries the fix', function () {
    var dist  = fs.existsSync(DIST_JS) ? fs.readFileSync(DIST_JS, 'utf8') : null;
    var block = dist ? notInBlock(dist) : null;

    it('07.1  control: the unminified bundle carries notIn()', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(block, "the bundle must carry instance['notIn']");
        assert.ok(stripComments(block).indexOf(KEY_REFUSAL) > -1, 'the bundle must carry the key refusal');
    });

    it('07.2  the bundle carries the own-row test and the splice by identity', function () {
        var live = stripComments(block);
        assert.ok(live.indexOf(IS_OWN_ROW) > -1, 'the bundle must carry the own-row test');
        assert.ok(TAKEN_OUT.test(live), 'the bundle must carry the splice by identity');
    });
});
