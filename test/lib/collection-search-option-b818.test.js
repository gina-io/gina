'use strict';
/**
 * #B818 / #B819 — a Collection search option matches the filter value as TEXT,
 * and never writes the rule table.
 *
 * `setSearchOption(field, 'isCaseSensitive', false)` makes the next search
 * compare `field` through the rule's template (`'^%s$'`, flag `i`). The raw
 * filter value was spliced into that template with a string replacer, and the
 * result was ASSIGNED back onto the rule entry. Two defects in one statement:
 *
 *  - #B818: the value was compiled as a pattern. A value holding an unbalanced
 *    parenthesis threw a SyntaxError out of the search; a dot matched any
 *    character, so `a.b` also selected `axb`, and `update` / `delete` then
 *    acted on both rows; `$&`-style sequences in a value were expanded.
 *  - #B819: the entry kept the FIRST value (its `%s` was gone), so every later
 *    option search on the instance matched that first value — and, through a
 *    rule table passed to the constructor, on every instance sharing the
 *    caller's options object.
 *
 * The rule's template is the pattern; the value is text.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix): equality without an
 *       option, the two rules on plain values, non-string values, `skipEval`
 *  02 — #B818: a value is matched as text (fix-sensitive)
 *  03 — #B818: the rows a mutator acts on (fix-sensitive)
 *  04 — #B819: the rule table is never written (fix-sensitive)
 *  05 — the template mechanism is kept: a constructor override of the rule
 *  06 — source pin (comment-stripped)
 *  07 — dist pin: the browser bundle carries the fix (lib/collection is bundled)
 *
 * Red-first: run against develop `95b473edc` before the fix. Suite 01 and the
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

// Every character a RegExp reads as syntax outside a character class.
var PATTERN_CHARS = ['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'];

var PEOPLE = [
    { name: 'Alice', city: 'Paris' },
    { name: 'Bob', city: 'Lyon' },
    { name: 'Alicia', city: 'Nice' }
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
 * A fresh Collection whose `name` field carries the `isCaseSensitive` option.
 *
 * @inner
 * @param {Array}   rows
 * @param {boolean} isCaseSensitive
 * @returns {Array} the Collection instance, option set
 */
function optioned(rows, isCaseSensitive) {
    return col(rows).setSearchOption('name', 'isCaseSensitive', isCaseSensitive);
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

// The write-back of the spliced pattern onto a rule entry (the pre-fix statement).
var WRITE_BACK = /\]\.re\s*=\s*searchOptionRules\[/;
// The value handed to the template through a FUNCTION replacer.
var FUNCTION_SPLICE = /\.re\.replace\(\/\\%s\/,\s*function\b/;


// ─── 01 — controls ────────────────────────────────────────────────────────────

describe('01 - #B818: controls (hold before and after the fix)', function () {

    it('01.1  without an option a value is compared by equality, pattern characters included', function () {
        assert.deepEqual(names(col([{ name: 'a (b' }, { name: 'a b' }]).find({ name: 'a (b' })), ['a (b']);
        assert.deepEqual(names(col([{ name: 'a.b' }, { name: 'axb' }]).find({ name: 'a.b' })), ['a.b']);
    });

    it('01.2  isCaseSensitive false finds a plain value written in another case', function () {
        assert.deepEqual(names(optioned(PEOPLE, false).find({ name: 'ALICE' })), ['Alice']);
        assert.deepEqual(names(optioned(PEOPLE, false).find({ name: 'Alice' })), ['Alice']);
    });

    it('01.3  isCaseSensitive true keeps the case', function () {
        assert.deepEqual(names(optioned(PEOPLE, true).find({ name: 'ALICE' })), []);
        assert.deepEqual(names(optioned(PEOPLE, true).find({ name: 'Alice' })), ['Alice']);
    });

    it('01.4  the whole value is compared: a prefix does not match', function () {
        assert.deepEqual(names(optioned(PEOPLE, false).find({ name: 'ali' })), []);
    });

    it('01.5  a number, a boolean, the empty string and an accented name read as before', function () {
        var rows = [{ name: 'A', n: 5, ok: true, s: '' }, { name: 'B', n: 7, ok: false, s: 'x' }];
        assert.deepEqual(names(col(rows).setSearchOption('n', 'isCaseSensitive', false).find({ n: 5 })), ['A']);
        assert.deepEqual(names(col(rows).setSearchOption('n', 'isCaseSensitive', false).find({ n: '5' })), ['A']);
        assert.deepEqual(names(col(rows).setSearchOption('ok', 'isCaseSensitive', false).find({ ok: true })), ['A']);
        assert.deepEqual(names(col(rows).setSearchOption('s', 'isCaseSensitive', false).find({ s: '' })), ['A']);
        assert.deepEqual(names(optioned([{ name: 'Élodie' }, { name: 'Bob' }], false).find({ name: 'élodie' })), ['Élodie']);
    });

    it('01.6  null under the option matches a null value and the text `null`, as before', function () {
        var rows = [{ name: 'A', v: null }, { name: 'B', v: 'null' }, { name: 'C', v: 'x' }];
        assert.deepEqual(names(col(rows).setSearchOption('v', 'isCaseSensitive', false).find({ v: null })), ['A', 'B']);
    });

    it('01.7  with skipEval set on the constructor, a value holding `=` is found in another case', function () {
        var c = col([{ name: 'A=B' }, { name: 'zzz' }], { searchOptionRules: { skipEval: true } });
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'a=b' })), ['A=B']);
    });

    it('01.8  a comparison still comes before the option: `>a` compares', function () {
        assert.deepEqual(names(optioned([{ name: 'bbb' }, { name: 'zzz' }, { name: 'a' }], false).find({ name: '>a' })), ['bbb', 'zzz']);
    });
});


// ─── 02 — a value is text ─────────────────────────────────────────────────────

describe('02 - #B818: a search-option value is matched as text', function () {

    it('02.1  the reported case: a value holding an unbalanced parenthesis finds its row', function () {
        var row = optioned([{ name: 'a (b' }], false).findOne({ name: 'a (b' });
        assert.ok(row, 'the row must be found, and the search must not throw');
        assert.equal(row.name, 'a (b');
    });

    it('02.2  the same value under isCaseSensitive true', function () {
        assert.deepEqual(names(optioned([{ name: 'a (b' }, { name: 'a b' }], true).find({ name: 'a (b' })), ['a (b']);
    });

    it('02.3  a dot matches a dot only', function () {
        assert.deepEqual(names(optioned([{ name: 'axb' }, { name: 'a.b' }], false).find({ name: 'a.b' })), ['a.b']);
        assert.deepEqual(names(optioned([{ name: 'axb' }, { name: 'a.b' }], true).find({ name: 'a.b' })), ['a.b']);
    });

    it('02.4  a value made of pattern characters selects no other row', function () {
        var rows = [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }];
        assert.deepEqual(names(optioned(rows, false).find({ name: '.*' })), []);
        assert.deepEqual(names(optioned(rows, false).find({ name: 'x|.*' })), []);
        assert.deepEqual(names(optioned(rows, false).find({ name: '[a-z]+' })), []);
    });

    it('02.5  a row whose name IS such a value is found by it', function () {
        assert.deepEqual(names(optioned([{ name: '.*' }, { name: 'one' }], false).find({ name: '.*' })), ['.*']);
        assert.deepEqual(names(optioned([{ name: 'x|y' }, { name: 'x' }, { name: 'y' }], false).find({ name: 'X|Y' })), ['x|y']);
    });

    it('02.6  balanced parentheses in another case find their row', function () {
        assert.deepEqual(names(optioned([{ name: 'Acme (UK)' }, { name: 'Acme UK' }], false).find({ name: 'acme (uk)' })), ['Acme (UK)']);
    });

    it('02.7  each pattern character is found as itself, in another case, and selects nothing else', function () {
        for (var i = 0; i < PATTERN_CHARS.length; ++i) {
            var ch   = PATTERN_CHARS[i];
            var name = 'a' + ch + 'b';
            var rows = [{ name: name }, { name: 'axb' }, { name: 'ab' }, { name: 'a' }, { name: 'b' }];
            assert.deepEqual(names(optioned(rows, false).find({ name: name.toUpperCase() })), [name], 'character `' + ch + '` under isCaseSensitive false');
            assert.deepEqual(names(optioned(rows, true).find({ name: name })), [name], 'character `' + ch + '` under isCaseSensitive true');
        }
    });

    it('02.8  a `$` sequence in a value is not expanded', function () {
        // A string replacer read `$&` as « the matched text »: the value `x$&y` became the pattern `^x%sy$`.
        assert.deepEqual(names(optioned([{ name: 'x$&y' }, { name: 'x%sy' }], false).find({ name: 'X$&Y' })), ['x$&y']);
        assert.deepEqual(names(optioned([{ name: 'a$$b' }, { name: 'a$b' }], false).find({ name: 'A$$B' })), ['a$$b']);
        assert.deepEqual(names(optioned([{ name: "a$'b" }, { name: 'a$b' }], false).find({ name: "A$'B" })), ["a$'b"]);
    });

    it('02.9  findOne and an OR search (two filters) read the value as text too', function () {
        assert.equal(optioned([{ name: 'axb' }, { name: 'a.b' }], false).findOne({ name: 'A.B' }).name, 'a.b');
        assert.deepEqual(names(optioned([{ name: 'axb' }, { name: 'a.b' }, { name: 'zzz' }], false).find({ name: 'A.B' }, { name: 'ZZZ' })), ['a.b', 'zzz']);
    });
});


// ─── 03 — the rows a mutator acts on ──────────────────────────────────────────

describe('03 - #B818: update and delete act on the rows the value names', function () {

    var ROWS = [{ id: 1, name: 'axb', v: 0 }, { id: 2, name: 'a.b', v: 0 }, { id: 3, name: 'zzz', v: 0 }];

    function versions(rows) {
        var out = [];
        for (var i = 0; i < rows.length; ++i) { out.push(rows[i].name + '/' + rows[i].v); }
        return out;
    }

    it('03.1  control: without the option update touches the equal row only', function () {
        assert.deepEqual(versions(col(ROWS).update({ name: 'a.b' }, { v: 1 }).toRaw()), ['axb/0', 'a.b/1', 'zzz/0']);
    });

    it('03.2  with the option update touches the row the value names, in another case', function () {
        assert.deepEqual(versions(optioned(ROWS, false).update({ name: 'A.B' }, { v: 1 }).toRaw()), ['axb/0', 'a.b/1', 'zzz/0']);
    });

    it('03.3  control: without the option delete removes the equal row only', function () {
        assert.deepEqual(names(col(ROWS).delete({ name: 'a.b' }).toRaw()), ['axb', 'zzz']);
    });

    it('03.4  with the option delete removes the row the value names, in another case', function () {
        assert.deepEqual(names(optioned(ROWS, false).delete({ name: 'A.B' }).toRaw()), ['axb', 'zzz']);
    });
});


// ─── 04 — the rule table is never written ─────────────────────────────────────

describe('04 - #B819: each option search matches its own value', function () {

    it('04.1  two searches on one instance', function () {
        var c = col(PEOPLE);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alice' })), ['Alice']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'bob' })), ['Bob']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alicia' })), ['Alicia']);
    });

    it('04.2  the other order', function () {
        var c = col(PEOPLE);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'bob' })), ['Bob']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alice' })), ['Alice']);
    });

    it('04.3  findOne after a first option search returns its own row', function () {
        var c = col(PEOPLE);
        c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alice' });
        assert.equal(c.setSearchOption('name', 'isCaseSensitive', false).findOne({ name: 'bob' }).name, 'Bob');
    });

    it('04.4  one search over two option fields finds the row', function () {
        var c = col(PEOPLE)
            .setSearchOption('name', 'isCaseSensitive', false)
            .setSearchOption('city', 'isCaseSensitive', false);
        assert.deepEqual(names(c.find({ name: 'alice', city: 'paris' })), ['Alice']);
    });

    it('04.5  the two rules keep working after each other on one instance', function () {
        var c = col(PEOPLE);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alice' })), ['Alice']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', true).find({ name: 'Bob' })), ['Bob']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'bob' })), ['Bob']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', true).find({ name: 'Alice' })), ['Alice']);
        assert.deepEqual(names(c.setSearchOption('name', 'isCaseSensitive', true).find({ name: 'alice' })), []);
    });

    it('04.6  a rule table shared by two instances keeps its template, and each instance its own value', function () {
        var options = { searchOptionRules: { isCaseSensitive: { false: { re: '^%s', modifiers: 'i' } } } };
        var first   = names(col(PEOPLE, options).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'ali' }));
        var second  = names(col(PEOPLE, options).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'bo' }));
        assert.deepEqual(first, ['Alice', 'Alicia']);
        assert.deepEqual(second, ['Bob']);
        assert.equal(options.searchOptionRules.isCaseSensitive.false.re, '^%s', 'the caller\'s template must not be written');
    });

    it('04.7  control: a fresh instance is unaffected by another instance', function () {
        col(PEOPLE).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'alice' });
        assert.deepEqual(names(col(PEOPLE).setSearchOption('name', 'isCaseSensitive', false).find({ name: 'bob' })), ['Bob']);
    });
});


// ─── 05 — the template mechanism ──────────────────────────────────────────────

describe('05 - #B818: a rule template passed to the constructor still applies', function () {

    var PREFIX = { searchOptionRules: { isCaseSensitive: { false: { re: '^%s', modifiers: 'i' } } } };

    function prefixed(rows) {
        return col(rows, JSON.parse(JSON.stringify(PREFIX))).setSearchOption('name', 'isCaseSensitive', false);
    }

    it('05.1  control: a `^%s` template gives a prefix search', function () {
        assert.deepEqual(names(prefixed(PEOPLE).find({ name: 'ali' })), ['Alice', 'Alicia']);
    });

    it('05.2  control: the rule the caller did not override keeps the default template', function () {
        var c = col(PEOPLE, JSON.parse(JSON.stringify(PREFIX))).setSearchOption('name', 'isCaseSensitive', true);
        assert.deepEqual(names(c.find({ name: 'Alice' })), ['Alice']);
        assert.deepEqual(names(col(PEOPLE, JSON.parse(JSON.stringify(PREFIX))).setSearchOption('name', 'isCaseSensitive', true).find({ name: 'Ali' })), []);
    });

    it('05.3  the value is text inside an overridden template too', function () {
        assert.deepEqual(names(prefixed([{ name: 'a.bc' }, { name: 'axbc' }, { name: 'zzz' }]).find({ name: 'A.B' })), ['a.bc']);
    });
});


// ─── 06 — source pin ──────────────────────────────────────────────────────────

describe('06 - #B818 / #B819: source — the value is escaped and the rule table is not written', function () {

    var raw  = fs.readFileSync(SRC, 'utf8');
    var live = stripComments(raw);

    it('06.1  control: the strip keeps live code and drops comments (the instrument)', function () {
        assert.ok(live.indexOf("instance['setSearchOption'] = function(") > -1, 'the strip must keep the setter');
        assert.ok(WRITE_BACK.test(raw), 'the retired statement must still be quoted in a comment, so this pin can fail');
        assert.equal(FUNCTION_SPLICE.test("// x.re.replace(/\\%s/, function () {"), true, 'the splice pin must match the statement shape');
    });

    it('06.2  live code no longer assigns the spliced pattern to a rule entry', function () {
        assert.equal(WRITE_BACK.test(live), false, 'no `.re = searchOptionRules[…]` assignment may remain in live code');
    });

    it('06.3  live code hands the value to the template through a function replacer', function () {
        assert.ok(FUNCTION_SPLICE.test(live), 'the `%s` splice must use a function replacer');
    });
});


// ─── 07 — dist pin ────────────────────────────────────────────────────────────

describe('07 - #B818 / #B819: the browser bundle carries the fix', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('07.1  the unminified bundle carries lib/collection (control), the function splice and no write-back', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf("instance['setSearchOption'] = function(") > -1, 'control: lib/collection must be in the bundle');
        assert.ok(FUNCTION_SPLICE.test(dist), 'the rebuilt bundle must carry the function splice');
        assert.equal(WRITE_BACK.test(dist), false, 'the rebuilt bundle must not carry the write-back');
    });
});
