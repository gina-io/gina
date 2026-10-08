'use strict';
/**
 * #B820 — the object form of `setSearchOption` accepts its documented shape.
 *
 * `setSearchOption` takes either three arguments (`field, rule, value`) or ONE
 * object keyed by field: `{ <field>: { <rule>: <value> } }`. The one-argument
 * form tested each top-level key — a FIELD name — against the rule table, so
 * the documented shape threw `undefined is not an allowed searchOption !`
 * (the message read the second argument, which that form does not have). Only
 * the three-argument form was usable.
 *
 * The object form now validates each field's rule names, coerces `'true'` /
 * `'false'` like the three-argument form, and keeps its own copy: the caller's
 * object is neither kept nor changed.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): the three-argument form,
 *       the argument-count and type refusals, the shapes the one-argument form
 *       already accepted
 *  02 — #B820: the documented object shape (fix-sensitive)
 *  03 — #B820: what the object form refuses, and what it leaves alone
 *  04 — source pin (comment-stripped)
 *  05 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `f655d94b7` before the fix. Suite 01 and the
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

var PEOPLE = [
    { name: 'Alice', city: 'Paris', n: 1 },
    { name: 'Bob', city: 'Lyon', n: 2 },
    { name: 'Alicia', city: 'Nice', n: 3 }
];

/**
 * A fresh Collection over a deep copy of `rows`.
 *
 * @inner
 * @param {Array} rows
 * @returns {Array} the Collection instance
 */
function col(rows) {
    return new Collection(JSON.parse(JSON.stringify(rows)));
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
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// The pre-fix check: a top-level key refused when it is not a rule name, with a message read from the second argument.
var FIELD_AS_RULE = /for \(var prop in arguments\[0\]\) \{\s*if \( typeof\(searchOptionRules\[prop\]\) == 'undefined' \)\s*throw new Error\(arguments\[1\]/;
// The fixed check: each rule name of a field entry is tested against the rule table.
var RULE_PER_FIELD = /for \(var ruleName in given\[prop\]\) \{\s*if \( typeof\(searchOptionRules\[ruleName\]\) == 'undefined' \)/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B820: controls (hold before and after the fix)', function () {

    it('01.1  the three-argument form sets the option for the next search', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'ALICE' })), ['Alice']);
    });

    it('01.2  the three-argument form refuses an unknown rule, naming it', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption('name', 'startsWith', true); }, /startsWith is not an allowed searchOption/);
    });

    it('01.3  zero, two and four arguments are refused', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption(); }, /searchOption cannot be left blank/);
        assert.throws(function () { col(PEOPLE).setSearchOption('name', 'isCaseSensitive'); }, /argument length mismatch/);
        assert.throws(function () { col(PEOPLE).setSearchOption('name', 'isCaseSensitive', false, 1); }, /argument length mismatch/);
    });

    it('01.4  a single argument that is not an object is refused', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption('name'); }, /searchOption must be an object/);
    });

    it('01.5  an empty object sets no option', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({}).find({ name: 'Alice' })), ['Alice']);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({}).find({ name: 'ALICE' })), []);
    });

    it('01.6  a top-level rule name is accepted and has no effect', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ skipEval: true }).find({ n: '>= 2' })), ['Bob', 'Alicia']);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ isCaseSensitive: false }).find({ name: 'ALICE' })), []);
    });

    it('01.7  the setter returns the instance, so the search chains', function () {
        var c = col(PEOPLE);
        assert.equal(c.setSearchOption('name', 'isCaseSensitive', false), c);
        c.find({ name: 'x' });
        assert.equal(c.setSearchOption({}), c);
    });
});


// ─── 02 — the documented shape ────────────────────────────────────────────────

describe('02 - #B820: setSearchOption({ field: { rule: value } })', function () {

    it('02.1  the documented shape sets the option for the next search', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false } }).find({ name: 'ALICE' })), ['Alice']);
    });

    it('02.2  it reads the value as text and applies to one search, like the three-argument form', function () {
        var c = col([{ name: 'axb' }, { name: 'a.b' }]);
        assert.deepEqual(names(c.setSearchOption({ name: { isCaseSensitive: false } }).find({ name: 'A.B' })), ['a.b']);
        assert.deepEqual(names(c.find({ name: 'A.B' })), [], 'the option is cleared after one search');
    });

    it('02.3  several fields in one object', function () {
        var c = col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false }, city: { isCaseSensitive: false } });
        assert.deepEqual(names(c.find({ name: 'alice', city: 'PARIS' })), ['Alice']);
    });

    it('02.4  isCaseSensitive true keeps the case', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: true } }).find({ name: 'ALICE' })), []);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: true } }).find({ name: 'Alice' })), ['Alice']);
    });

    it('02.5  the texts `true` and `false` are read as booleans, like the three-argument form', function () {
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: 'false' } }).find({ name: 'ALICE' })), ['Alice']);
        assert.deepEqual(names(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: 'true' } }).find({ name: 'ALICE' })), []);
    });

    it('02.6  findOne, update and delete take the option from the object form too', function () {
        assert.equal(col(PEOPLE).setSearchOption({ name: { isCaseSensitive: false } }).findOne({ name: 'BOB' }).name, 'Bob');
        var rows = [{ id: 1, name: 'Alice', v: 0 }, { id: 2, name: 'Bob', v: 0 }];
        var updated = col(rows).setSearchOption({ name: { isCaseSensitive: false } }).update({ name: 'BOB' }, { v: 1 }).toRaw();
        assert.deepEqual(updated.map(function (r) { return r.name + '/' + r.v; }), ['Alice/0', 'Bob/1']);
        assert.deepEqual(names(col(rows).setSearchOption({ name: { isCaseSensitive: false } }).delete({ name: 'BOB' }).toRaw()), ['Alice']);
    });

    it('02.7  the object form replaces what an earlier setter call had set', function () {
        var c = col(PEOPLE).setSearchOption('city', 'isCaseSensitive', false).setSearchOption({ name: { isCaseSensitive: false } });
        assert.deepEqual(names(c.find({ name: 'ALICE' })), ['Alice']);
        var d = col(PEOPLE).setSearchOption('city', 'isCaseSensitive', false).setSearchOption({ name: { isCaseSensitive: false } });
        assert.deepEqual(names(d.find({ city: 'PARIS' })), [], 'the city option of the earlier call is gone');
    });
});


// ─── 03 — refusals, and what is left alone ────────────────────────────────────

describe('03 - #B820: what the object form refuses and leaves alone', function () {

    it('03.1  an unknown rule inside a field is refused, naming the rule', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: { startsWith: true } }); }, /startsWith is not an allowed searchOption/);
    });

    it('03.2  a field whose entry is not an object of rules is refused, naming the field', function () {
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: false }); }, /searchOption `name` must be an object of rules/);
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: null }); }, /searchOption `name` must be an object of rules/);
        assert.throws(function () { col(PEOPLE).setSearchOption({ name: ['isCaseSensitive'] }); }, /searchOption `name` must be an object of rules/);
    });

    it('03.3  a refused object leaves no option behind', function () {
        var c = col(PEOPLE);
        assert.throws(function () { c.setSearchOption({ name: { isCaseSensitive: false }, city: { startsWith: true } }); }, /startsWith is not an allowed searchOption/);
        assert.deepEqual(names(c.find({ name: 'ALICE' })), []);
    });

    it('03.4  the caller\'s object is not changed by the search', function () {
        var given = { name: { isCaseSensitive: false } };
        col(PEOPLE).setSearchOption(given).find({ name: 'ALICE' });
        assert.deepEqual(given, { name: { isCaseSensitive: false } });
        assert.deepEqual(Object.keys(given), ['name']);
    });

    it('03.5  the caller\'s object is not kept: changing it after the call changes nothing', function () {
        var given = { name: { isCaseSensitive: false } };
        var c = col(PEOPLE).setSearchOption(given);
        given.name.isCaseSensitive = true;
        delete given.name;
        assert.deepEqual(names(c.find({ name: 'ALICE' })), ['Alice']);
    });

    it('03.6  a top-level rule name beside a field is accepted and has no effect', function () {
        var c = col([{ name: 'bbb' }, { name: 'zzz' }, { name: 'a' }]).setSearchOption({ name: { isCaseSensitive: false }, skipEval: true });
        assert.deepEqual(names(c.find({ name: '>a' })), ['bbb', 'zzz'], 'the comparison still applies: skipEval is a constructor option');
    });
});


// ─── 04 — source pin ──────────────────────────────────────────────────────────

describe('04 - #B820: source — the object form validates rule names per field', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code (the instrument)', function () {
        assert.ok(live.indexOf("instance['setSearchOption'] = function(") > -1, 'the strip must keep the setter');
        assert.equal(RULE_PER_FIELD.test("// for (var ruleName in given[prop]) {\n// if ( typeof(searchOptionRules[ruleName]) == 'undefined' )"), false, 'the pin must not match across comment lines');
    });

    it('04.2  live code no longer tests a field name against the rule table', function () {
        assert.equal(FIELD_AS_RULE.test(live), false, 'the top-level-key check that read arguments[1] must be gone from live code');
    });

    it('04.3  live code tests each rule name of a field entry', function () {
        assert.ok(RULE_PER_FIELD.test(live), 'the object form must validate rule names per field');
    });
});


// ─── 05 — dist pin ────────────────────────────────────────────────────────────

describe('05 - #B820: the browser bundle carries the fix', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/collection (control) and the per-field check', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf("instance['setSearchOption'] = function(") > -1, 'control: lib/collection must be in the bundle');
        assert.ok(RULE_PER_FIELD.test(dist), 'the rebuilt bundle must carry the per-field check');
        assert.equal(FIELD_AS_RULE.test(dist), false, 'the rebuilt bundle must not carry the retired check');
    });
});
