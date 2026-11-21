'use strict';
/**
 * #B823 — a within-array filter on a plain sub-field (`'tags[*].label'`)
 * matches the rows whose array holds a matching element.
 *
 * A filter key `'<array>[*].<field>'` reads `<field>` from each element of the
 * row's array; the row matches when one element matches. The search handed
 * the WHOLE element to the comparison, whose every branch refuses an object,
 * so an array of objects never matched: the form shown in the class JSDoc,
 * `find({ 'tags[*].label': 'news' })`, returned no row. A dotted rest
 * (`'reviews[*].ratings.score'`) took another path and worked.
 *
 * Now an element that is an object has its field read, like a plain key is
 * read from a row, and the sub-field is compared like that plain key. An
 * element that is not an object (a string, a number, `null`) is compared as
 * itself, as before, so every filter that matched still matches.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): the dotted rest, the
 *       elements that are not objects, the keys that match nothing
 *  02 — #B823: an array of objects (fix-sensitive)
 *  03 — #B823: the sub-field is compared like a plain key (fix-sensitive)
 *  04 — source pin (comment-stripped)
 *  05 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `70211de1a` before the fix. Suite 01, 02.4
 * (a non-match, empty before the fix too) and the arms marked « control »
 * held; every other arm was red.
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
var commentStrip = require('../strip-comments');

var ROWS = [
    { name: 'A', tags: [{ label: 'News', score: 5 }, { label: 'Sport', score: 1 }], reviews: [{ ratings: { score: 4 } }] },
    { name: 'B', tags: [{ label: 'Tech', score: 3 }], reviews: [{ ratings: { score: 2 } }] },
    { name: 'C', tags: [] },
    { name: 'D' }
];

/**
 * A fresh Collection over a deep copy of `rows`.
 *
 * @inner
 * @param {Array}  rows
 * @param {object} [options] - constructor options, passed through as given
 * @returns {Array} the Collection instance
 */
function col(rows, options) {
    return new Collection(JSON.parse(JSON.stringify(rows)), options);
}

/**
 * The `name` of each row of a result.
 *
 * @inner
 * @param {Array} rows
 * @returns {Array<string>}
 */
function names(rows) {
    var out = [];
    for (var i = 0; i < (rows || []).length; ++i) { out.push(rows[i].name); }
    return out;
}

/**
 * A filter object with one key.
 *
 * @inner
 * @param {string} key
 * @param {*}      value
 * @returns {object}
 */
function filterOf(key, value) {
    var f = {};
    f[key] = value;
    return f;
}

/**
 * What a search returns: the names it finds, or the first line of the error it throws.
 *
 * @inner
 * @param {function} fn - runs the search
 * @returns {{names: Array<string>}|{throws: string}}
 */
function outcome(fn) {
    try {
        return { names: names(fn()) };
    } catch (err) {
        return { throws: String(err.message).split('\n')[0] };
    }
}

/**
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return commentStrip.lines(s);
}

// The pre-fix call: the whole element handed to search().
var WHOLE_ELEMENT = /search\(filter, field, collection\[c\], subMatched, searchOptionRules\)/;
// The fixed read: an element that is an object gives its field.
var ELEMENT_FIELD = /\( collection\[c\] !== null && typeof\(collection\[c\]\) == 'object' \) \? collection\[c\]\[field\] : collection\[c\]/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B823: controls (hold before and after the fix)', function () {

    it('01.1  a dotted rest inside an array of objects finds its row', function () {
        assert.deepEqual(names(col(ROWS).find({ 'reviews[*].ratings.score': '>= 4' })), ['A']);
        assert.deepEqual(names(col(ROWS).find({ 'reviews[*].ratings.score': 2 })), ['B']);
    });

    it('01.2  an element that is a string is still compared as itself', function () {
        var rows = [{ name: 'P', tags: ['News', 'Sport'] }, { name: 'Q', tags: ['Tech'] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'Sport' })), ['P']);
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'Tech' })), ['Q']);
    });

    it('01.3  a null element is still matched by a null filter', function () {
        var rows = [{ name: 'N', tags: [null] }, { name: 'M', tags: ['x'] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': null })), ['N']);
    });

    it('01.4  a field no element holds, an empty array and a missing array match nothing', function () {
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].color': 'red' })), []);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].color': null })), [], 'a missing field is not null');
        assert.deepEqual(names(col(ROWS).find({ 'items[*].label': 'News' })), []);
    });

    it('01.5  a field holding an object matches no text', function () {
        var rows = [{ name: 'E', tags: [{ label: { en: 'News' } }] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'News' })), []);
    });

    it('01.6  a plain key on a row is compared as before', function () {
        assert.deepEqual(names(col(ROWS).find({ name: 'B' })), ['B']);
    });
});


// ─── 02 — an array of objects ─────────────────────────────────────────────────

describe('02 - #B823: a plain sub-field reads each element of an array of objects', function () {

    it('02.1  the reported case: the row whose array holds the label is found', function () {
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'News' })), ['A']);
    });

    it('02.2  the example of the class JSDoc', function () {
        var rows = [{ name: 'A', tags: [{ label: 'news' }] }, { name: 'B', tags: [{ label: 'tech' }] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'news' })), ['A']);
    });

    it('02.3  any element of the array may match, not only the first', function () {
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'Sport' })), ['A']);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'Tech' })), ['B']);
    });

    it('02.4  the value is compared with the case it has', function () {
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'news' })), []);
    });

    it('02.5  a number, a comparison and `not null`', function () {
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].score': 3 })), ['B']);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].score': '>= 4' })), ['A']);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].score': '< 2' })), ['A']);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'not null' })), ['A', 'B']);
    });

    it('02.6  a field holding null is matched by a null filter', function () {
        var rows = [{ name: 'A', tags: [{ label: null }] }, { name: 'B', tags: [{ label: 'x' }] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': null })), ['A']);
    });

    it('02.7  an array mixing objects and strings', function () {
        var rows = [{ name: 'A', tags: ['News', { label: 'Tech' }] }, { name: 'B', tags: [{ label: 'News' }] }];
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'Tech' })), ['A']);
        assert.deepEqual(names(col(rows).find({ 'tags[*].label': 'News' })), ['A', 'B']);
    });

    it('02.8  with another key (AND) and as one of several filters (OR)', function () {
        assert.deepEqual(names(col(ROWS).find({ name: 'A', 'tags[*].label': 'Sport' })), ['A']);
        assert.deepEqual(names(col(ROWS).find({ name: 'B', 'tags[*].label': 'Sport' })), []);
        assert.deepEqual(names(col(ROWS).find({ 'tags[*].label': 'News' }, { 'tags[*].label': 'Tech' })), ['A', 'B']);
    });

    it('02.9  findOne, update and delete act on the row found', function () {
        assert.equal(col(ROWS).findOne({ 'tags[*].label': 'Tech' }).name, 'B');
        var updated = col(ROWS).update({ 'tags[*].label': 'Tech' }, { v: 1 }).toRaw();
        assert.deepEqual(updated.map(function (r) { return r.name + '/' + (r.v || 0); }), ['A/0', 'B/1', 'C/0', 'D/0']);
        assert.deepEqual(names(col(ROWS).delete({ 'tags[*].label': 'Tech' }).toRaw()), ['A', 'C', 'D']);
    });
});


// ─── 03 — compared like a plain key ───────────────────────────────────────────

describe('03 - #B823: the sub-field is compared like a plain key', function () {

    // Each FLAT row carries on the row the fields its NESTED twin carries in the one element of `tags`.
    var FLAT = [
        { name: 'A', label: 'News', score: 5 },
        { name: 'B', label: 'a=b', score: 3 },
        { name: 'C', label: null, score: 0 },
        { name: 'D', score: 1 }
    ];
    var NESTED = FLAT.map(function (r) {
        var el = {};
        for (var k in r) { if (k !== 'name') { el[k] = r[k]; } }
        return { name: r.name, tags: [el] };
    });
    var CASES = [
        ['label', 'News'], ['label', 'news'], ['label', 'not null'], ['label', null], ['label', 'a=b'], ['label', ''],
        ['score', 5], ['score', '5'], ['score', '>= 3'], ['score', '< 1'], ['score', 0]
    ];

    it('03.1  each value gives the same rows, or the same error, on the sub-field and on the plain key', function () {
        for (var i = 0; i < CASES.length; ++i) {
            var field = CASES[i][0], value = CASES[i][1];
            var flat   = outcome(function () { return col(FLAT).find(filterOf(field, value)); });
            var nested = outcome(function () { return col(NESTED).find(filterOf('tags[*].' + field, value)); });
            assert.deepEqual(nested, flat, '`' + field + '` = ' + JSON.stringify(value));
        }
    });

    it('03.2  the same with `skipEval` passed to the constructor', function () {
        for (var i = 0; i < CASES.length; ++i) {
            var field = CASES[i][0], value = CASES[i][1];
            var flat   = outcome(function () { return col(FLAT, { searchOptionRules: { skipEval: true } }).find(filterOf(field, value)); });
            var nested = outcome(function () { return col(NESTED, { searchOptionRules: { skipEval: true } }).find(filterOf('tags[*].' + field, value)); });
            assert.deepEqual(nested, flat, '`' + field + '` = ' + JSON.stringify(value) + ' with skipEval');
        }
    });

    it('03.3  with `skipEval`, a value holding `=` is compared as text on the sub-field', function () {
        assert.deepEqual(names(col(NESTED, { searchOptionRules: { skipEval: true } }).find({ 'tags[*].label': 'a=b' })), ['B']);
    });

    it('03.4  control: the instrument tells a throw from a result, and two results apart', function () {
        var thrown = outcome(function () { return col(FLAT).find({ label: 'a=b' }); });
        assert.ok(typeof(thrown.throws) == 'string' && thrown.throws.length > 0, 'a search that throws must read as `throws`');
        assert.notDeepEqual(outcome(function () { return col(FLAT).find({ label: 'News' }); }), thrown);
        assert.notDeepEqual(outcome(function () { return col(FLAT).find({ label: 'News' }); }), outcome(function () { return col(FLAT).find({ score: 3 }); }));
    });
});


// ─── 04 — source pin ──────────────────────────────────────────────────────────

describe('04 - #B823: source — searchWithin reads the field of an object element', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code, and the retired call is still quoted in a comment', function () {
        assert.ok(live.indexOf('var searchWithin = function(filter, f, _content, matched, i) {') > -1, 'the strip must keep searchWithin');
        assert.ok(WHOLE_ELEMENT.test(raw), 'the retired call must still be quoted in a comment, so this pin can fail');
    });

    it('04.2  live code no longer hands the whole element to search()', function () {
        assert.equal(WHOLE_ELEMENT.test(live), false, 'the whole-element call must be gone from live code');
    });

    it('04.3  live code reads the field of an element that is an object', function () {
        assert.ok(ELEMENT_FIELD.test(live), 'searchWithin must read collection[c][field] for an object element');
    });
});


// ─── 05 — dist pin ────────────────────────────────────────────────────────────

describe('05 - #B823: the browser bundle carries the fix', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/collection (control) and the element-field read', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('var searchWithin = function(filter, f, _content, matched, i) {') > -1, 'control: lib/collection must be in the bundle');
        assert.ok(ELEMENT_FIELD.test(dist), 'the rebuilt bundle must carry the element-field read');
        assert.equal(WHOLE_ELEMENT.test(dist), false, 'the rebuilt bundle must not carry the whole-element call');
    });
});
