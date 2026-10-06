'use strict';
/**
 * #B517 — `filter(fn)` on a Collection or a Collection result filters like
 * `Array.prototype.filter`.
 *
 * A Collection, and every array its query methods return (`find`, `orderBy`,
 * `limit`, `notIn`, …), carries an OWN method named `filter`. It is a FIELD
 * PROJECTION: `rows.filter('name')` returns `[{ name }, …]` and
 * `rows.filter(['id', 'name'])` keeps those two keys. Called with a FUNCTION it
 * read the function as a field name, matched nothing and returned `[]`, with no
 * error: a list emptied silently. A function now filters like
 * `Array.prototype.filter` (callback `(row, index, array)`, optional `thisArg`)
 * and returns a `find()`-style result — the matching rows, the same objects,
 * with the methods `find()` attaches, so `.toRaw()` and the chain still work.
 * A string or an array keeps the projection.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): the projection forms, the
 *       native filter on a `toRaw()` copy, `filter(undefined)` still throws
 *  02 — a function filters (fix-sensitive): on the instance and on each result kind
 *  03 — the callback contract (fix-sensitive): its arguments and `thisArg`
 *  04 — the result is `find()`-style (fix-sensitive): same rows, the methods, the chain
 *  05 — source pin: `instance['filter']` dispatches on a function (comment-stripped)
 *  06 — dist pin: the browser bundle carries the dispatch (lib/collection is bundled)
 *
 * Red-first: suites 02–06 were run against develop `6275ae320` before the fix:
 * every arm red except 04.5, a control that holds on both sides.
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

var ROWS = [
    { id: 1, name: 'a', active: true },
    { id: 2, name: 'b', active: false },
    { id: 3, name: 'c', active: true }
];

/**
 * A fresh Collection over a copy of ROWS.
 *
 * @inner
 * @returns {Array} the Collection instance
 */
function mk() {
    return new Collection(JSON.parse(JSON.stringify(ROWS)));
}

/**
 * The ids of a list of rows.
 *
 * @inner
 * @param {Array} rows
 * @returns {Array<number>}
 */
function ids(rows) {
    var out = [];
    for (var i = 0; i < rows.length; ++i) { out.push(rows[i].id); }
    return out;
}

function isActive(r) { return r.active === true; }

// The methods find() attaches to its results (lib/collection, the end of `find`).
var FIND_METHODS = ['notIn', 'find', 'update', 'replace', 'or', 'findOne', 'limit', 'orderBy', 'delete', 'toRaw', 'filter'];

/**
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// The fixed dispatch, as live code carries it.
var DISPATCH = /if \( typeof\(filter\) == 'function' \) \{\s*var filtered\s*= Array\.prototype\.filter\.call\(result, filter, thisArg\);/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B517: the controls (hold before and after the fix)', function () {

    it('01.1  a field name projects each row (the projection form)', function () {
        assert.deepEqual(mk().find({}).filter('name'), [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    });

    it('01.2  a list of field names projects each row onto them', function () {
        assert.deepEqual(mk().find({}).filter(['id', 'name']), [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);
    });

    it('01.3  native filter on a toRaw() copy (the result the fix must match)', function () {
        assert.deepEqual(ids(mk().find({}).toRaw().filter(isActive)), [1, 3]);
    });

    it('01.4  filter(undefined) still throws', function () {
        assert.throws(function () { mk().find({}).filter(); }, /filter/);
    });
});


// ─── 02 — a function filters ──────────────────────────────────────────────────

describe('02 - #B517: a function filters like Array.prototype.filter', function () {

    it('02.1  on a find() result', function () {
        assert.deepEqual(ids(mk().find({}).filter(isActive)), [1, 3]);
    });

    it('02.2  on the Collection instance itself', function () {
        assert.deepEqual(ids(mk().filter(isActive)), [1, 3]);
    });

    it('02.3  on an orderBy() result, keeping its order', function () {
        assert.deepEqual(ids(mk().orderBy({ id: 'desc' }).filter(isActive)), [3, 1]);
    });

    it('02.4  on a limit() result', function () {
        assert.deepEqual(ids(mk().find({}).limit(2).filter(isActive)), [1]);
    });

    it('02.5  on a notIn() result', function () {
        assert.deepEqual(ids(mk().notIn({ id: 1 }).filter(isActive)), [3]);
    });

    it('02.6  on an empty Collection, still a find()-style result', function () {
        var out = new Collection([]).filter(isActive);
        assert.ok(Array.isArray(out));
        assert.equal(out.length, 0);
        assert.equal(typeof out.toRaw, 'function', 'an empty result must chain like a non-empty one');
    });
});


// ─── 03 — the callback contract ───────────────────────────────────────────────

describe('03 - #B517: the callback receives (row, index, array) and honours thisArg', function () {

    it('03.1  the arguments are the row, its index and the array filtered', function () {
        var src = mk().find({}), seen = [];
        src.filter(function (row, index, array) { seen.push([row.id, index, array === src]); return true; });
        assert.deepEqual(seen, [[1, 0, true], [2, 1, true], [3, 2, true]]);
    });

    it('03.2  thisArg is the callback\'s `this`', function () {
        var ctx = { wanted: 2 };
        var out = mk().find({}).filter(function (row) { return row.id === this.wanted; }, ctx);
        assert.deepEqual(ids(out), [2]);
    });
});


// ─── 04 — a find()-style result ───────────────────────────────────────────────

describe('04 - #B517: filter(fn) returns a find()-style result', function () {

    it('04.1  the matching rows are the same objects, as native filter returns them', function () {
        var src = mk().find({});
        var out = src.filter(isActive);
        assert.equal(out[0], src[0]);
        assert.equal(out[1], src[2]);
    });

    it('04.2  it carries the methods find() attaches', function () {
        var out = mk().find({}).filter(isActive);
        FIND_METHODS.forEach(function (m) {
            assert.equal(typeof out[m], 'function', 'missing ' + m);
        });
    });

    it('04.3  .toRaw() strips the internal _uuid, as on a find() result', function () {
        var rows = mk().find({}).filter(isActive);
        assert.ok(typeof rows[0]._uuid != 'undefined', 'control: the rows carry _uuid before toRaw()');
        var raw = rows.toRaw();
        assert.deepEqual(raw, [{ id: 1, name: 'a', active: true }, { id: 3, name: 'c', active: true }]);
    });

    it('04.4  the chain continues: orderBy(), a projection, and another filter(fn)', function () {
        var out = mk().find({}).filter(isActive);
        assert.deepEqual(ids(out.orderBy({ id: 'desc' })), [3, 1]);
        assert.deepEqual(out.filter('name'), [{ name: 'a' }, { name: 'c' }]);
        assert.deepEqual(ids(out.filter(function (r) { return r.id > 1; })), [3]);
    });

    it('04.5  control: the source result is not modified (holds before the fix too)', function () {
        var src = mk().find({});
        src.filter(isActive);
        assert.deepEqual(ids(src), [1, 2, 3]);
    });
});


// ─── 05 — source pin ──────────────────────────────────────────────────────────

describe('05 - #B517: source — filter dispatches on a function', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('05.1  control: the strip keeps live code (the instrument)', function () {
        assert.ok(live.indexOf("instance['filter'] = function(") > -1, 'the strip must keep the filter method');
        assert.equal(DISPATCH.test("// if ( typeof(filter) == 'function' ) {"), false, 'the pin must not match a comment line');
    });

    it('05.2  live code dispatches a function to Array.prototype.filter', function () {
        assert.ok(DISPATCH.test(live), 'instance[\'filter\'] must hand a function to Array.prototype.filter');
    });
});


// ─── 06 — dist pin ────────────────────────────────────────────────────────────

describe('06 - #B517: the browser bundle carries the dispatch', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('06.1  the unminified bundle carries lib/collection (control) and the dispatch', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf("instance['filter'] = function(") > -1, 'control: lib/collection must be in the bundle');
        assert.ok(DISPATCH.test(dist), 'the rebuilt bundle must carry the function dispatch');
    });
});
