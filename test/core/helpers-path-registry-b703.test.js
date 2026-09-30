'use strict';
/**
 * #B703 — helpers/path.js keeps no path registry.
 *
 * helpers/index.js calls the PathHelper export WITHOUT `new`, so `this` in its body was the
 * global object: `this.paths = []` created `global.paths`, every `_()` pushed each distinct
 * normalized path into it for the process lifetime (the output cache builds two per distinct
 * request URL), and every `_()` and every PathObject `toString()` scanned it with `indexOf` —
 * memory and per-call CPU growing with the number of distinct paths ever seen (103 µs per
 * unseen path at ~52k entries, measured). Nothing read it: each lookup returned the entry
 * equal to the value it searched for. The registry is gone; `toUnixStyle()` returns the
 * value, `toWin32Style()` converts it on every call.
 *
 *  §01 source pins — on comment-stripped text: no `.paths.push(`, `.paths.indexOf(` or
 *      `this.paths = [` in code, and both style helpers derive from `self.value` alone. The
 *      strip is checked to have kept the code (anti-vacuity), and the helpers extract
 *      brace-balanced on both revisions (the extraction control).
 *  §02 behavioural, no registry — the source under test is compiled AS helpers/path.js (so its
 *      relative requires resolve from helpers/) and its export called the way helpers/index.js
 *      calls it, without `new`: `global.paths` is not created, 10,000 distinct paths through
 *      both forms grow no array on the global object, and a `new`-constructed helper owns no
 *      `paths` and grows no array either.
 *  §03 behavioural, identity controls (GREEN on both revisions) — exact outputs of the value,
 *      toString(), toUnixStyle(), toWin32Style() and of the string form, for unix- and
 *      win32-shaped inputs, with and without `force`. The expected strings were captured from
 *      the pre-fix code.
 *  §04 the one intended change — after cleanSlashes() rewrote a value (a trailing separator
 *      stripped), toWin32Style() converts it; the registry had not recorded the rewritten
 *      value and returned it with forward slashes.
 *
 * Seam: GINA_PATH_HELPER_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/helpers/path.js` (the pre-fix bytes): the §01 registry and helper pins,
 * the three §02 arms and §04's conversion arm read RED; the §01 anti-vacuity and extraction
 * controls, every §03 identity arm and §04's two controls stay GREEN.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var Module = require('module');

var FW     = require('../fw');
var REAL   = path.join(FW, 'helpers/path.js');
var SOURCE = process.env.GINA_PATH_HELPER_SRC || REAL;

// every expectation below is the unix contract (toString() returns the win32 form on win32)
var NOT_UNIX = process.platform === 'win32' ? 'the expectations are the unix contract' : false;

var src, active;
// the source under test, compiled as helpers/path.js
var PathHelperSrc = null;
before(function () {
    src = fs.readFileSync(SOURCE, 'utf8');
    // block comments out, then every full-line `//` comment (the file keeps commented-out
    // debug lines, and the #B703 note names the retired registry)
    active = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
    // lib/merge and the real helpers first (the globals and modules the helper family
    // expects), then the text under test compiled as the same file and called the way
    // helpers/index.js calls it — without `new` — so every arm below runs ITS `_`
    require(path.join(FW, 'lib/merge'));
    require(path.join(FW, 'helpers'));
    var m = new Module(REAL, null);
    m.filename = REAL;
    m.paths = Module._nodeModulePaths(path.dirname(REAL));
    m._compile(src, REAL);
    PathHelperSrc = m.exports;
    PathHelperSrc();
});

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * Slices `function … { … }` starting at `decl`, walking braces from the first `{` after the
 * declaration until it closes (the jsdoc.md started-flag walker).
 */
function extractFn(text, decl) {
    var at = text.indexOf(decl);
    if (at < 0) { return null; }
    var fnStart = text.indexOf('function', at);
    var depth = 0, started = false, i = fnStart;
    for (; i < text.length; i++) {
        var c = text[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return (started && depth === 0) ? text.slice(fnStart, i) : null;
}

var UNIX_DECL  = 'var toUnixStyle = function(self) {';
var WIN32_DECL = 'var toWin32Style = function(self) {';

describe('§01 source pins — no registry in code', function () {

    it('anti-vacuity: the strip removed comment text and kept the code', function () {
        assert.ok(active.length < src.length, 'the strip removed comment text');
        assert.ok(active.indexOf('function PathHelper(') > -1, 'the strip kept the declaration');
        assert.equal(count(active, UNIX_DECL), 1, 'the strip kept toUnixStyle');
        assert.equal(count(active, WIN32_DECL), 1, 'the strip kept toWin32Style');
    });

    it('no push into a paths registry', function () {
        assert.equal(count(active, '.paths.push('), 0, '_() must not record the paths it normalizes');
    });

    it('no indexOf scan of a paths registry', function () {
        assert.equal(count(active, '.paths.indexOf('), 0, 'neither _() nor toString() may scan a registry');
    });

    it('no registry array is declared', function () {
        assert.equal(count(active, 'this.paths = ['), 0, 'PathHelper() must not create a paths array (on the global object, as helpers/index.js calls it)');
    });

    it('control: both style helpers extract brace-balanced', function () {
        var u = extractFn(active, UNIX_DECL), w = extractFn(active, WIN32_DECL);
        assert.ok(u, 'toUnixStyle extracts');
        assert.ok(w, 'toWin32Style extracts');
        assert.equal(count(u, '{'), count(u, '}'));
        assert.equal(count(w, '{'), count(w, '}'));
    });

    it('toUnixStyle returns the value it was given, with no lookup', function () {
        var u = extractFn(active, UNIX_DECL);
        assert.ok(/return\s+self\.value\s*;/.test(u), 'returns self.value');
        assert.equal(count(u, 'indexOf'), 0, 'no lookup');
    });

    it('toWin32Style converts the value on every call, with no lookup', function () {
        var w = extractFn(active, WIN32_DECL);
        assert.ok(w.indexOf('self.value.replace(/\\//g, "\\\\")') > -1, 'converts self.value');
        assert.equal(count(w, 'indexOf'), 0, 'no lookup');
    });
});

function arrayLengths(obj) {
    var out = {};
    Object.getOwnPropertyNames(obj).forEach(function (k) {
        var d = Object.getOwnPropertyDescriptor(obj, k);
        if (d && 'value' in d && Array.isArray(d.value)) { out[k] = d.value.length; }
    });
    return out;
}

function grown(before, after) {
    return Object.keys(after).filter(function (k) {
        return after[k] - (before[k] || 0) >= 100;
    }).map(function (k) { return k + ' +' + (after[k] - (before[k] || 0)); });
}

describe('§02 behavioural — no registry, no growth', { skip: NOT_UNIX }, function () {

    it('called as helpers/index.js calls it (no `new`), it creates no global.paths', function () {
        assert.equal(typeof PathHelperSrc, 'function', 'the compiled source exports PathHelper');
        assert.equal(typeof globalThis.paths, 'undefined', 'global.paths must not exist');
    });

    it('10,000 distinct paths through both forms grow no array on the global object', function () {
        var before = arrayLengths(globalThis);
        for (var i = 0; i < 5000; i++) {
            var o = new _('/srv/b703/grow/' + i + '/page.html?q=' + i, true);
            o.toString(); o.toUnixStyle(); o.toWin32Style();
            _('/srv/b703/grow-string/' + i + '.js');
        }
        assert.deepEqual(grown(before, arrayLengths(globalThis)), [], 'an array on the global object grew with the paths seen');
    });

    it('a `new`-constructed helper owns no paths array and grows none', function () {
        var inst = new PathHelperSrc();
        assert.equal(Object.prototype.hasOwnProperty.call(inst, 'paths'), false, 'the instance owns no paths');
        var before = arrayLengths(inst);
        for (var i = 0; i < 1000; i++) { new _('/srv/b703/instance/' + i + '.html').toString(); }
        assert.deepEqual(grown(before, arrayLengths(inst)), [], 'an array on the helper instance grew with the paths seen');
    });
});

describe('§03 behavioural — identity controls (unchanged outputs)', { skip: NOT_UNIX }, function () {

    // captured from the pre-fix code; toString() and toUnixStyle() equal the value, the string
    // form equals it too (force only matters on win32), toWin32Style() swaps every `/`
    var CASES = [
        ['/srv/app/src/demo/controllers/setup.js', '/srv/app/src/demo/controllers/setup.js', '\\srv\\app\\src\\demo\\controllers\\setup.js'],
        ['/srv//app/./src/../lib/x.js',             '/srv/app/lib/x.js',                      '\\srv\\app\\lib\\x.js'],
        ['/srv/app/public/',                        '/srv/app/public/',                       '\\srv\\app\\public\\'],
        ['C:\\data\\folder\\file',                  'C:/data/folder/file',                    'C:\\data\\folder\\file'],
        ['C:\\data/other file\\x.txt',              'C:/data/other file/x.txt',               'C:\\data\\other file\\x.txt'],
        ['\\\\192.168.0.1\\folder\\file',           '//192.168.0.1/folder/file',              '\\\\192.168.0.1\\folder\\file'],
        ['app/src/x.js',                            'app/src/x.js',                           'app\\src\\x.js'],
        ['/srv/app/cache/search?q=a&p=1.html',      '/srv/app/cache/search?q=a&p=1.html',     '\\srv\\app\\cache\\search?q=a&p=1.html']
    ];

    CASES.forEach(function (c) {
        it(JSON.stringify(c[0]) + ' — value, toString, toUnixStyle, toWin32Style, string form', function () {
            [false, true].forEach(function (force) {
                var o = new _(c[0], force);
                assert.equal(o.value, c[1], 'value (force ' + force + ')');
                assert.equal(o.toString(), c[1], 'toString (force ' + force + ')');
                assert.equal(o.toUnixStyle(), c[1], 'toUnixStyle (force ' + force + ')');
                assert.equal(o.toWin32Style(), c[2], 'toWin32Style (force ' + force + ')');
                assert.equal(_(c[0], force), c[1], 'string form (force ' + force + ')');
            });
        });
    });
});

describe('§04 the one intended change — toWin32Style() after cleanSlashes()', { skip: NOT_UNIX }, function () {

    // a path no other arm constructs without its trailing separator, so the pre-fix registry
    // never recorded the rewritten value
    var o = null;
    before(function () {
        o = new _('/srv/b703/cleaned-' + process.pid + '/trailing/');
        o.isValidPath(); // runs cleanSlashes(), which strips the trailing separator
    });

    it('control: cleanSlashes() rewrote the value', function () {
        assert.equal(o.value, '/srv/b703/cleaned-' + process.pid + '/trailing');
    });

    it('toWin32Style() converts the rewritten value', function () {
        assert.equal(o.toWin32Style(), '\\srv\\b703\\cleaned-' + process.pid + '\\trailing');
    });

    it('control: toString() still returns the value', function () {
        assert.equal(o.toString(), '/srv/b703/cleaned-' + process.pid + '/trailing');
    });
});
