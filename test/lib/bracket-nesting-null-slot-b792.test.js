'use strict';
/**
 * #B792 — a bracket-notation field whose path descends into a slot an EARLIER pair
 * set to `null` (a JSON value like `a=[null]`, or `a={"x":null}`) no longer throws.
 *
 * Pre-fix, `parseLocalObj`'s container-creation guard fired only for `undefined` and
 * `string` slots; a `null` slot (typeof === 'object') fell through, the recursion
 * descended into it, and `null[seg]` threw `Cannot read properties of null`. From the
 * GET/HEAD `inheritedData` call site the throw had no try/catch and exited the bundle
 * process — the same SIGTERM class as #B591 (which removed a DIFFERENT null seed and
 * left this one). The fix treats a null slot like a string one: replace it with a
 * fresh container (last-write-wins) and descend. The validator plugin's client twin
 * (`nestBracketNotationKey`) carries the identical guard.
 *
 * Seams (red-first against `git show HEAD:` copies, no shared-tree touch):
 *   B792_DATA_SRC=<path>       the helpers/data/src/main.js copy to load and drive
 *   B792_VALIDATOR_SRC=<path>  the validator main.js copy the twin is extracted from
 *
 * The twin is extracted and evaluated from the REAL source the way
 * test/core/validator-send-formdata-nesting.test.js does (same anchors), so the
 * parity arms run shipped bytes, not a replica.
 *
 * Run standalone: node --test test/lib/bracket-nesting-null-slot-b792.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var FW     = require('../fw');

var DATA_SRC      = process.env.B792_DATA_SRC      || path.join(FW, 'helpers', 'data', 'src', 'main.js');
var VALIDATOR_SRC = process.env.B792_VALIDATOR_SRC || path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'main.js');

require(path.resolve(DATA_SRC))();                       // installs the implicit globals
var formatDataFromString   = global.formatDataFromString;
var parseLocalObj          = global.nestBracketNotationKey;   // the server alias of parseLocalObj

var mainSrc = fs.readFileSync(path.resolve(VALIDATOR_SRC), 'utf8');

/** Direct sloppy-mode eval so the self-recursive reference inside the body resolves. */
function extractFn(src, name) {
    return (function () {
        var __fn;
        eval(src + '\n__fn = ' + name + ';');   // eslint-disable-line no-eval
        return __fn;
    })();
}

// the client twin — same anchors as the #B92 / #B591 parity tests
var twin = (function () {
    var start = mainSrc.indexOf('var nestBracketNotationKey = function');
    var end   = mainSrc.indexOf('/**\n     * send', start);
    assert.ok(start > -1 && end > start, 'nestBracketNotationKey source not isolatable');
    return extractFn(mainSrc.substring(start, end), 'nestBracketNotationKey');
})();

// the pre-fix shapes log [365] on the document path; keep the runner quiet
var origError = null;
before(function () { origError = console.error; console.error = function () {}; });
after(function () { console.error = origError; });


describe('01 - #B792: a path descending into a planted-null slot nests instead of throwing (server)', function () {

    it('`a=[null]&a[0][b]=1` — the JSON value plants null at a[0]; the later path replaces it', function () {
        var out;
        assert.doesNotThrow(function () { out = formatDataFromString('a=[null]&a[0][b]=1'); });
        assert.deepEqual(out, { a: [ { b: '1' } ] });
    });

    it('`a={"x":null}&a[x][y]=1` — null planted at a.x by a JSON object value', function () {
        var out;
        assert.doesNotThrow(function () { out = formatDataFromString('a={"x":null}&a[x][y]=1'); });
        assert.deepEqual(out, { a: { x: { y: '1' } } });
    });

    it('parseLocalObj on an accumulator whose slot is already null returns it nested, in place', function () {
        var acc = [ null ], ret;
        assert.doesNotThrow(function () { ret = parseLocalObj(acc, ['0', 'b'], 0, '1'); });
        assert.strictEqual(ret, acc, 'the accumulator is mutated in place and returned');
        assert.deepEqual(acc, [ { b: '1' } ]);
    });
});


describe('02 - #B792: controls (non-discriminating by design) — nothing else moves', function () {

    it('a non-null primitive slot still boxes and no-ops (only the crashing null case changed)', function () {
        assert.deepEqual(formatDataFromString('a=[true]&a[0][b]=1'), { a: [ true ] });
        assert.deepEqual(formatDataFromString('a=[1]&a[0][b]=1'),    { a: [ 1 ] });
    });

    it('ordinary nesting is unchanged', function () {
        assert.deepEqual(formatDataFromString('user[name]=Ada&user[age]=37'), { user: { name: 'Ada', age: '37' } });
    });

    it('the #B446 prototype-pollution guard is intact', function () {
        formatDataFromString('__proto__[polluted]=OWNED');
        assert.equal({}.polluted, undefined);
        assert.deepEqual(formatDataFromString('a=[null]&__proto__[x]=1'), { a: [ null ] });
        assert.equal({}.x, undefined);
    });
});


describe('03 - #B792: the client twin agrees — parity on planted-null accumulators (real extracted bytes)', function () {

    it('twin and server nest a planted-null array slot identically, neither throws', function () {
        var mine = [ null ], src = [ null ];
        assert.doesNotThrow(function () { mine = twin(mine, ['0', 'b'], 0, '1'); }, 'twin threw');
        assert.doesNotThrow(function () { src  = parseLocalObj(src, ['0', 'b'], 0, '1'); }, 'server threw');
        assert.deepEqual(mine, src);
        assert.deepEqual(src, [ { b: '1' } ]);
    });

    it('twin and server nest a planted-null OBJECT slot identically', function () {
        var mine = { x: null }, src = { x: null };
        assert.doesNotThrow(function () { mine = twin(mine, ['x', 'y'], 0, '1'); });
        assert.doesNotThrow(function () { src  = parseLocalObj(src, ['x', 'y'], 0, '1'); });
        assert.deepEqual(mine, src);
        assert.deepEqual(src, { x: { y: '1' } });
    });
});
