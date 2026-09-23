'use strict';
/**
 * #B591 — a bracket-notation field name whose NON-LAST segment is numeric while
 * its container is not an array (`0[a]=1`, `a[0][b]=2` after `a[x]=1`) no longer
 * throws inside the nesting helper.
 *
 * Pre-fix, `parseLocalObj` rebound a LOCAL (`obj = []`) that the parent never saw,
 * seeded the slot below with null and recursed into it — every path through the
 * rebind threw a TypeError. From the GET/HEAD `inheritedData` call site the throw
 * had no try/catch and exited the bundle process (measured live: exit 143). The
 * validator plugin's client twin (`nestBracketNotationKey`) carried the same code.
 *
 * Seams (red-first against `git show HEAD:` copies, no shared-tree touch):
 *   B591_DATA_SRC=<path>       the helpers/data/src/main.js copy to load and drive
 *   B591_VALIDATOR_SRC=<path>  the validator main.js copy the twin is extracted from
 *
 * The twin is extracted and evaluated from the REAL source the way
 * test/core/validator-send-formdata-nesting.test.js does (same anchors), so the
 * parity arms run shipped bytes, not a replica.
 *
 * Run standalone: node --test test/lib/bracket-nesting-b591.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var FW     = require('../fw');

var DATA_SRC      = process.env.B591_DATA_SRC      || path.join(FW, 'helpers', 'data', 'src', 'main.js');
var VALIDATOR_SRC = process.env.B591_VALIDATOR_SRC || path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'main.js');

require(path.resolve(DATA_SRC))();                       // installs the implicit globals
var formatDataFromString   = global.formatDataFromString;
var nestBracketNotationKey = global.nestBracketNotationKey;   // the server alias of parseLocalObj

var dataSrc = fs.readFileSync(path.resolve(DATA_SRC), 'utf8');
var mainSrc = fs.readFileSync(path.resolve(VALIDATOR_SRC), 'utf8');

/** Direct sloppy-mode eval so the self-recursive reference inside the body resolves. */
function extractFn(src, name) {
    return (function () {
        var __fn;
        eval(src + '\n__fn = ' + name + ';');   // eslint-disable-line no-eval
        return __fn;
    })();
}

// the client twin — same anchors as the #B92 parity test
var twinSrc = (function () {
    var start = mainSrc.indexOf('var nestBracketNotationKey = function');
    var end   = mainSrc.indexOf('/**\n     * send', start);
    assert.ok(start > -1 && end > start, 'nestBracketNotationKey source not isolatable');
    return mainSrc.substring(start, end);
})();
var twin = extractFn(twinSrc, 'nestBracketNotationKey');

// the server function's own source slice (the real def follows a commented-out older copy)
var parseLocalObjSrc = (function () {
    var start = dataSrc.lastIndexOf('var parseLocalObj = function');
    var end   = dataSrc.indexOf('} //EO DataHelper', start);
    assert.ok(start > -1 && end > start, 'parseLocalObj source not isolatable');
    return dataSrc.substring(start, end);
})();

function codeOnly(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); })
              .map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

// the pre-fix shapes log [365] on the document path; keep the runner quiet
var origError = null;
before(function () { origError = console.error; console.error = function () {}; });
after(function () { console.error = origError; });


describe('01 - #B591: the throwing shapes now nest (server helper)', function () {

    it('`0[a]=1` — a numeric ROOT segment under the object accumulator', function () {
        var out;
        assert.doesNotThrow(function () { out = formatDataFromString('0[a]=1'); });
        assert.deepEqual(out, { '0': { a: '1' } });
    });

    it('`a[x]=1&a[0][b]=2` — a numeric segment under a slot that is already an object', function () {
        var out;
        assert.doesNotThrow(function () { out = formatDataFromString('a[x]=1&a[0][b]=2'); });
        assert.deepEqual(out, { a: { x: '1', '0': { b: '2' } } });
    });

    it('nestBracketNotationKey({}, [\'0\',\'a\'], 0, \'1\') returns the SAME accumulator, nested', function () {
        var acc = {}, ret;
        assert.doesNotThrow(function () { ret = nestBracketNotationKey(acc, ['0', 'a'], 0, '1'); });
        assert.strictEqual(ret, acc, 'the accumulator is mutated in place and returned — never replaced');
        assert.deepEqual(acc, { '0': { a: '1' } });
    });

    it('the inheritedData / GET-document shape (`{"0[a]":"1","page":"2"}`) parses instead of dropping the whole document', function () {
        var out = formatDataFromString('{"0[a]":"1","page":"2"}');
        assert.deepEqual(out, { '0': { a: '1' }, page: '2' });
    });
});


describe('02 - #B591: the client twin agrees — parity on the extended battery (real extracted bytes)', function () {

    var paths = [
        // the #B92 battery
        [ ['item','0','id'],                 'x' ],
        [ ['item','1','id'],                 'y' ],
        [ ['item','0','nested','1','value'], 'z' ],
        [ ['a','b','c'],                     'p' ],
        [ ['top'],                           'q' ],
        [ ['n','0'],                         'r' ],
        [ ['n','1'],                         's' ],
        // the #B591 shapes
        [ ['0','a'],                         '1' ],
        [ ['0','a','b'],                     '2' ],
        [ ['1','x'],                         '3' ]
    ];

    it('single-entry parity across the battery — neither side throws', function () {
        paths.forEach(function (p) {
            var mine, src;
            assert.doesNotThrow(function () { mine = twin({}, p[0].slice(), 0, p[1]); }, 'twin threw on ' + JSON.stringify(p[0]));
            assert.doesNotThrow(function () { src  = nestBracketNotationKey({}, p[0].slice(), 0, p[1]); }, 'server threw on ' + JSON.stringify(p[0]));
            assert.deepEqual(mine, src, 'diverged on ' + JSON.stringify(p[0]));
        });
    });

    it('accumulated parity — an object slot followed by a numeric segment under the same name', function () {
        var seq = [ [ ['a','x'], '1' ], [ ['a','0','b'], '2' ], [ ['a','0','c'], '3' ] ];
        var mine = {}, src = {};
        seq.forEach(function (p) {
            assert.doesNotThrow(function () { mine = twin(mine, p[0].slice(), 0, p[1]); });
            assert.doesNotThrow(function () { src  = nestBracketNotationKey(src, p[0].slice(), 0, p[1]); });
        });
        assert.deepEqual(mine, src);
        assert.deepEqual(src, { a: { x: '1', '0': { b: '2', c: '3' } } });
    });
});


describe('03 - #B591: every previously non-throwing shape is unchanged (controls)', function () {

    it('arrays are still built by the look-ahead on the NEXT segment', function () {
        assert.deepEqual(formatDataFromString('a[0][b]=1&a[0][c]=2&a[1][b]=3'), { a: [ { b: '1', c: '2' }, { b: '3' } ] });
        assert.deepEqual(formatDataFromString('item[0][id]=x'), { item: [ { id: 'x' } ] });
        assert.deepEqual(formatDataFromString('a[1]=y&a[0]=x'), { a: [ 'x', 'y' ] });
    });

    it('a leading non-zero index still yields a holed array', function () {
        var out = formatDataFromString('design[1][id]=s');
        assert.ok(Array.isArray(out.design));
        assert.equal(out.design.length, 2);
        assert.deepEqual(out.design[1], { id: 's' });
    });

    it('plain nesting, string-slot re-creation and last-wins are unchanged', function () {
        assert.deepEqual(formatDataFromString('user[name]=Ada&user[age]=37'), { user: { name: 'Ada', age: '37' } });
        assert.deepEqual(formatDataFromString('a=1&a[b]=2'), { a: { b: '2' } });
        assert.deepEqual(formatDataFromString('a[b]=2&a=1'), { a: '1' });
    });

    it('the #B446 segment guard still drops the path (both sides)', function () {
        assert.deepEqual(nestBracketNotationKey({}, ['__proto__', 'polluted'], 0, 'OWNED'), {});
        assert.deepEqual(twin({}, ['__proto__', 'polluted'], 0, 'OWNED'), {});
        assert.strictEqual({}.polluted, undefined);
    });
});


describe('04 - #B591: source pins — the rebind is gone from BOTH copies (comment-stripped)', function () {

    it('helpers/data parseLocalObj carries no live `obj = [];`', function () {
        assert.ok(codeOnly(parseLocalObjSrc).indexOf('obj = [];') < 0, 'the local rebind must not return');
        // anti-vacuity: the raw slice still names it in the `// was:` record
        assert.ok(parseLocalObjSrc.indexOf('obj = [];') > -1, 'the was: record is kept');
    });

    it('the validator twin carries no live `obj = [];`', function () {
        assert.ok(codeOnly(twinSrc).indexOf('obj = [];') < 0, 'the local rebind must not return in the twin');
        assert.ok(twinSrc.indexOf('obj = [];') > -1, 'the was: record is kept');
    });

    it('the server alias and the array look-ahead are still in place', function () {
        assert.match(dataSrc, /nestBracketNotationKey\s*=\s*parseLocalObj;/);
        assert.match(codeOnly(parseLocalObjSrc), /obj\[ key\[k\] \] = \( \/\^\\d\+\$\/\.test\(key\[k\+1\]\) \) \? \[\] : \{\};/);
    });
});
