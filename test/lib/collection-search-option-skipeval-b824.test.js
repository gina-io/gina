'use strict';
/**
 * #B824 — a per-field `skipEval` is refused by `setSearchOption`, in both
 * forms, with an Error naming the constructor option.
 *
 * `skipEval` is a constructor option: `new Collection(rows,
 * { searchOptionRules: { skipEval: true } })` turns the comparison off for
 * plain keys. `setSearchOption` accepted it as a FIELD rule too — three
 * arguments `setSearchOption('name', 'skipEval', true)` or one object
 * `setSearchOption({ name: { skipEval: true } })` — and the search then looked
 * the value up in the rule's table of entries. `skipEval` has no such table
 * (it is a boolean), the lookup found nothing, and the field matched no row,
 * with no error.
 *
 * Both forms now refuse a rule that is not a table of entries, naming the
 * constructor option. A top-level `skipEval` in the object form is accepted and
 * has no effect, as before (#B820), and the constructor option is unchanged.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): the constructor option,
 *       the top-level key of the object form, the per-field rule that works,
 *       the refusal of an unknown rule
 *  02 — #B824: a per-field `skipEval` is refused (fix-sensitive)
 *  03 — source pin (comment-stripped)
 *  04 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run before the fix, on develop `70211de1a` with the #B823 change
 * applied (it does not touch `setSearchOption`). Suite 01 and the arms marked
 * « control » held; every other arm was red.
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

var PEOPLE = [
    { name: 'Alice', n: 1 },
    { name: 'Bob', n: 2 },
    { name: 'Alicia', n: 3 }
];

// The refusal, as both forms word it.
var REFUSED = /searchOption `skipEval` cannot be set on a field: it is a constructor option/;
// The constructor option the message names.
var NAMED_OPTION = 'new Collection(rows, { searchOptionRules: { skipEval: true } })';

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
 * The message of the Error `fn` throws, or null when it throws nothing.
 *
 * @inner
 * @param {function} fn
 * @returns {string|null}
 */
function thrownMessage(fn) {
    try {
        fn();
    } catch (err) {
        return String(err.message);
    }
    return null;
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

// The refusal in the three-argument form: a rule that is not a table of entries.
var THREE_ARG_REFUSAL = /if \( !searchOptionRules\[arguments\[1\]\] \|\| typeof\(searchOptionRules\[arguments\[1\]\]\) != 'object' \)\s*throw new Error\(/;
// The refusal in the object form, for each rule of a field entry.
var OBJECT_REFUSAL = /if \( !searchOptionRules\[ruleName\] \|\| typeof\(searchOptionRules\[ruleName\]\) != 'object' \)\s*throw new Error\(/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B824: controls (hold before and after the fix)', function () {

    it('01.1  the constructor option turns the comparison off for a plain key', function () {
        assert.deepEqual(names(col(PEOPLE).find({ n: '>= 2' })), ['Bob', 'Alicia']);
        assert.deepEqual(names(col(PEOPLE, { searchOptionRules: { skipEval: true } }).find({ n: '>= 2' })), []);
        assert.deepEqual(names(col([{ name: 'A=B' }, { name: 'zzz' }], { searchOptionRules: { skipEval: true } }).find({ name: 'A=B' })), ['A=B']);
    });

    it('01.2  a top-level skipEval in the object form is accepted and has no effect', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ skipEval: true }).find({ n: '>= 2' })), ['Bob', 'Alicia']);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false }, skipEval: true }).find({ name: 'ALICE' })), ['Alice']);
    });

    it('01.3  isCaseSensitive is set on a field in both forms', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'ALICE' })), ['Alice']);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false } }).find({ name: 'ALICE' })), ['Alice']);
    });

    it('01.4  an unknown rule is still refused by name, in both forms', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption('name', 'startsWith', true); }, /startsWith is not an allowed searchOption/);
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: { startsWith: true } }); }, /startsWith is not an allowed searchOption/);
    });

    it('01.5  without an option the field is found', function () {
        assert.deepEqual(names(col(PEOPLE).find({ name: 'Alice' })), ['Alice']);
    });
});


// ─── 02 — a per-field skipEval ────────────────────────────────────────────────

describe('02 - #B824: a per-field skipEval is refused', function () {

    it('02.1  the three-argument form throws, naming the constructor option', function () {
        var msg = thrownMessage(function () { col(PEOPLE).setSearchOption('name', 'skipEval', true); });
        assert.ok(msg, 'setSearchOption(\'name\', \'skipEval\', true) must throw');
        assert.match(msg, REFUSED);
        assert.ok(msg.indexOf(NAMED_OPTION) > -1, 'the message must name ' + NAMED_OPTION + ': ' + msg);
    });

    it('02.2  the three-argument form throws whatever the value', function () {
        var values = [false, 'true', 'false'];
        for (var i = 0; i < values.length; ++i) {
            var v = values[i];
            assert.throws(function () { col(PEOPLE).setSearchOption('name', 'skipEval', v); }, REFUSED, 'value ' + JSON.stringify(v));
        }
    });

    it('02.3  the object form throws for skipEval inside a field, alone or beside a valid rule', function () {
        var msg = thrownMessage(function () { col(PEOPLE).setSearchOption({ name: { skipEval: true } }); });
        assert.ok(msg, 'setSearchOption({ name: { skipEval: true } }) must throw');
        assert.match(msg, REFUSED);
        assert.ok(msg.indexOf(NAMED_OPTION) > -1, 'the message must name ' + NAMED_OPTION + ': ' + msg);
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false, skipEval: true } }); }, REFUSED);
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: { skipEval: false } }); }, REFUSED);
    });

    it('02.4  a refused call sets no option: the next search finds the field as without one', function () {
        var a = col(PEOPLE);
        assert.throws(function () { a.setSearchOption('name', 'skipEval', true); }, REFUSED);
        assert.deepEqual(names(a.find({ name: 'Alice' })), ['Alice']);
        assert.deepEqual(names(a.find({ name: 'ALICE' })), []);
        var b = col(PEOPLE);
        assert.throws(function () { b.setSearchOption({ name: { skipEval: true } }); }, REFUSED);
        assert.deepEqual(names(b.find({ name: 'Alice' })), ['Alice']);
    });

    it('02.5  the call is refused before any row is updated or removed', function () {
        var rows = [{ id: 1, name: 'Alice', v: 0 }, { id: 2, name: 'Bob', v: 0 }];
        var c = col(rows);
        assert.throws(function () { c.setSearchOption('name', 'skipEval', true).update({ name: 'Alice' }, { v: 1 }); }, REFUSED);
        assert.deepEqual(c.toRaw().map(function (r) { return r.name + '/' + r.v; }), ['Alice/0', 'Bob/0']);
        assert.throws(function () { col(rows).setSearchOption({ name: { skipEval: true } }).delete({ name: 'Alice' }); }, REFUSED);
    });
});


// ─── 03 — source pin ──────────────────────────────────────────────────────────

describe('03 - #B824: source — both forms refuse a rule that is not a table of entries', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('03.1  control: the strip keeps live code, and the pins do not match across comment lines', function () {
        assert.ok(live.indexOf("instance['setSearchOption'] = function(") > -1, 'the strip must keep the setter');
        assert.equal(OBJECT_REFUSAL.test(stripComments("// if ( !searchOptionRules[ruleName] || typeof(searchOptionRules[ruleName]) != 'object' )\n//     throw new Error(")), false, 'a commented-out refusal must not satisfy the pin');
    });

    it('03.2  the three-argument form refuses it', function () {
        assert.ok(THREE_ARG_REFUSAL.test(live), 'the three-argument form must refuse a rule that is not a table of entries');
    });

    it('03.3  the object form refuses it', function () {
        assert.ok(OBJECT_REFUSAL.test(live), 'the object form must refuse a rule that is not a table of entries');
    });
});


// ─── 04 — dist pin ────────────────────────────────────────────────────────────

describe('04 - #B824: the browser bundle carries the fix', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries lib/collection (control) and both refusals', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf("instance['setSearchOption'] = function(") > -1, 'control: lib/collection must be in the bundle');
        assert.ok(THREE_ARG_REFUSAL.test(dist), 'the rebuilt bundle must carry the three-argument refusal');
        assert.ok(OBJECT_REFUSAL.test(dist), 'the rebuilt bundle must carry the object-form refusal');
    });
});
