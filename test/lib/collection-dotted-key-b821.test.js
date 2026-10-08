'use strict';
/**
 * #B821 — a dotted filter key holding a pattern character matches nothing
 * instead of throwing.
 *
 * A filter key with a dot is a property path (`'address.city'`), also inside
 * an array of objects (`'reviews[*].ratings.score'`). The function that walks
 * such a path first built a RegExp from the key's LAST segment — and never
 * read it. A key whose last segment held `(`, `)` or `[` therefore threw a
 * SyntaxError out of the search, before the path check a few lines below could
 * refuse the key. Any other dotted key that is not a property path matched
 * nothing; this one threw.
 *
 * The dead construction is gone: such a key matches nothing, like the others.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): the dotted forms that
 *       work, and a dotted key that is not a path and holds no pattern character
 *  02 — #B821: a pattern character in the last segment (fix-sensitive)
 *  03 — source pin (comment-stripped)
 *  04 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `eb14ed4ec` before the fix. Suite 01 and the
 * arms marked « control » held; every other arm was red.
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
    { name: 'A', address: { city: 'Paris', zip: 75 }, reviews: [{ ratings: { score: 4 } }] },
    { name: 'B', address: { city: 'Lyon', zip: 69 }, reviews: [{ ratings: { score: 2 } }] }
];

// The characters that made the key-built expression invalid.
var THROWING_CHARS = ['(', ')', '['];

/**
 * A fresh Collection over a deep copy of ROWS.
 *
 * @inner
 * @returns {Array} the Collection instance
 */
function mk() {
    return new Collection(JSON.parse(JSON.stringify(ROWS)));
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
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// The dead construction: a RegExp built from the key's last segment.
var KEY_BUILT = /re = new RegExp\('\("' \+ field \+ '":/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B821: controls (hold before and after the fix)', function () {

    it('01.1  a dotted key finds its row', function () {
        assert.deepEqual(names(mk().find({ 'address.city': 'Paris' })), ['A']);
    });

    it('01.2  a comparison on a dotted key', function () {
        assert.deepEqual(names(mk().find({ 'address.zip': '>= 70' })), ['A']);
    });

    it('01.3  a dotted sub-field inside an array of objects', function () {
        assert.deepEqual(names(mk().find({ 'reviews[*].ratings.score': '>= 4' })), ['A']);
    });

    it('01.4  a dotted key that is not a property path, and holds no pattern character, matches nothing', function () {
        assert.deepEqual(names(mk().find({ 'address.ci ty': 'Paris' })), []);
        assert.deepEqual(names(mk().find({ 'address.ci-ty': 'Paris' })), []);
    });

    it('01.5  a pattern character in a segment that is NOT the last one matches nothing', function () {
        assert.deepEqual(names(mk().find({ 'ad(dress.city': 'Paris' })), []);
    });

    it('01.6  a pattern character that left the expression valid matches nothing', function () {
        assert.deepEqual(names(mk().find({ 'address.ci*ty': 'Paris' })), []);
        assert.deepEqual(names(mk().find({ 'address.ci|ty': 'Paris' })), []);
    });
});


// ─── 02 — a pattern character in the last segment ─────────────────────────────

describe('02 - #B821: a dotted key holding a pattern character matches nothing', function () {

    it('02.1  find does not throw and returns no row', function () {
        for (var i = 0; i < THROWING_CHARS.length; ++i) {
            var key = 'address.ci' + THROWING_CHARS[i] + 'ty';
            assert.deepEqual(names(mk().find(filterOf(key, 'Paris'))), [], 'key `' + key + '`');
        }
    });

    it('02.2  findOne returns null', function () {
        for (var i = 0; i < THROWING_CHARS.length; ++i) {
            var key = 'address.ci' + THROWING_CHARS[i] + 'ty';
            assert.equal(mk().findOne(filterOf(key, 'Paris')), null, 'key `' + key + '`');
        }
    });

    it('02.3  the same inside an array of objects', function () {
        for (var i = 0; i < THROWING_CHARS.length; ++i) {
            var key = 'reviews[*].ratings.sc' + THROWING_CHARS[i] + 'ore';
            assert.deepEqual(names(mk().find(filterOf(key, '>= 4'))), [], 'key `' + key + '`');
        }
    });

    it('02.4  a key made of the character alone, after the dot', function () {
        assert.deepEqual(names(mk().find({ 'address.(': 'Paris' })), []);
        assert.deepEqual(names(mk().find({ 'address.[': 'Paris' })), []);
    });

    it('02.5  such a key beside a valid one: no row matches, and the search does not throw', function () {
        assert.deepEqual(names(mk().find({ name: 'A', 'address.ci(ty': 'Paris' })), []);
    });

    it('02.6  an OR search still returns the rows of its valid filter', function () {
        assert.deepEqual(names(mk().find({ 'address.ci(ty': 'Paris' }, { 'address.city': 'Lyon' })), ['B']);
    });
});


// ─── 03 — source pin ──────────────────────────────────────────────────────────

describe('03 - #B821: source — no RegExp is built from a filter key', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('03.1  control: the strip keeps live code, and the retired statement is still quoted in a comment', function () {
        assert.ok(live.indexOf('var searchThroughProp = function(filter, f, _content, matched) {') > -1, 'the strip must keep the path walker');
        assert.ok(KEY_BUILT.test(raw), 'the retired statement must still be quoted in a comment, so this pin can fail');
    });

    it('03.2  live code builds no RegExp from the key', function () {
        assert.equal(KEY_BUILT.test(live), false, 'the key-built RegExp must be gone from live code');
    });
});


// ─── 04 — dist pin ────────────────────────────────────────────────────────────

describe('04 - #B821: the browser bundle carries the fix', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries lib/collection (control) and no key-built RegExp', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('var searchThroughProp = function(filter, f, _content, matched) {') > -1, 'control: lib/collection must be in the bundle');
        assert.equal(KEY_BUILT.test(dist), false, 'the rebuilt bundle must not carry the key-built RegExp');
    });
});
