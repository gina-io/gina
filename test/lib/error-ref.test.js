'use strict';
/**
 * #ERRREF — `lib/error-ref`, the incident-ref mint for errors answered outside a
 * controller (the fast lane, #P49, is its first caller).
 *
 * A JSON error body carries a top-level `ref`: a caller-supplied value when it is
 * relay-safe (1-32 word characters, dots or dashes), else 6 fresh uppercase hex
 * characters. The controller and the server keep their own byte-identical copies
 * of that rule (`_mintErrorRef`, pinned by test/core/error-ref.test.js); this
 * module is the third copy, so it is driven against theirs.
 *
 *  01 — the mint: format, variance, a relay-safe ref honoured, every other value
 *       minted, never a throw.
 *  02 — parity: controller.js and server.js `_mintErrorRef`, extracted and run as
 *       real bytes, honour and refuse exactly the inputs this module does.
 *  03 — the registry entry is a plain `require` and GinaLib declares it.
 *
 * Seam: `GINA_ERROR_REF_MAIN=<file>` loads that file instead of the tree's
 * `lib/error-ref` (red-first against a tree without it).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var crypto = require('crypto');

var FW        = require('../fw');
var MAIN_PATH = process.env.GINA_ERROR_REF_MAIN || path.join(FW, 'lib/error-ref/src/main.js');
var errorRef  = require(MAIN_PATH);

var CTRL_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var SRV_SRC  = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var IDX_SRC  = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');
var DTS_SRC  = fs.readFileSync(path.join(FW, '../../types/index.d.ts'), 'utf8');

var HEX6 = /^[0-9A-F]{6}$/;

/**
 * Extract a `var <name> = function(...) { … };` declaration by walking its braces,
 * and compile it with `crypto` in scope.
 *
 * @inner
 * @param {string} src
 * @param {string} decl - the declaration's opening text
 * @returns {function}
 */
function extractMint(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, 'declaration found: ' + decl);
    assert.equal(src.indexOf(decl, at + 1), -1, 'declared exactly once: ' + decl);
    var i = src.indexOf('{', at), depth = 0, started = false, end = -1;
    for (; i < src.length; ++i) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > at, 'balanced body');
    var fnSrc = src.substring(src.indexOf('function', at), end);
    return new Function('crypto', 'return (' + fnSrc + ');')(crypto);
}

/** The inputs every copy must classify the same way. */
var MATRIX = [
    undefined, null, '', 'A', 'ORDER-42', 'a.b-c_d', 'x'.repeat(32), 'x'.repeat(33),
    'bad ref', 'bad!', 'é', 'line\nbreak', '[ ref X ]', 42, {}, ['ORDER'], true
];

/** `true` when the mint returned the input itself, `false` when it minted. */
function honours(mint, value) {
    var out = mint(value);
    if (out === value) { return true; }
    assert.match(out, HEX6, 'a refused value mints 6 uppercase hex: ' + JSON.stringify(value) + ' -> ' + out);
    return false;
}

describe('#ERRREF lib/error-ref §01 — the mint', function () {

    it('mints 6 uppercase hex characters, a different one per call', function () {
        var seen = {};
        for (var i = 0; i < 50; ++i) {
            var r = errorRef.mint();
            assert.match(r, HEX6);
            seen[r] = true;
        }
        assert.ok(Object.keys(seen).length > 40, 'refs vary (' + Object.keys(seen).length + '/50 distinct)');
    });

    it('honours a relay-safe ref, up to 32 characters', function () {
        ['ORDER-42', 'a.b-c_d', 'A', 'x'.repeat(32)].forEach(function (v) {
            assert.equal(errorRef.mint(v), v);
        });
    });

    it('mints for every other value — never forwards it, never throws', function () {
        ['', 'x'.repeat(33), 'bad ref', 'bad!', 'é', 'line\nbreak', '[ ref X ]', undefined, null, 42, {}, ['ORDER'], true].forEach(function (v) {
            var r;
            assert.doesNotThrow(function () { r = errorRef.mint(v); }, JSON.stringify(v));
            assert.match(r, HEX6, JSON.stringify(v) + ' -> ' + r);
        });
    });
});

describe('#ERRREF lib/error-ref §02 — parity with the controller and server copies', function () {

    var ctrlMint = extractMint(CTRL_SRC, 'var _mintErrorRef = function(supplied) {');
    var srvMint  = extractMint(SRV_SRC,  'var _mintErrorRef = function(supplied) {');

    it('the extracted copies run (control: they mint and honour)', function () {
        assert.match(ctrlMint(), HEX6);
        assert.equal(ctrlMint('ORDER-42'), 'ORDER-42');
        assert.match(srvMint(), HEX6);
        assert.equal(srvMint('ORDER-42'), 'ORDER-42');
    });

    it('all three honour and refuse exactly the same inputs', function () {
        MATRIX.forEach(function (v) {
            var mine = honours(errorRef.mint, v);
            assert.equal(honours(ctrlMint, v), mine, 'controller vs lib/error-ref on ' + JSON.stringify(v));
            assert.equal(honours(srvMint, v),  mine, 'server vs lib/error-ref on ' + JSON.stringify(v));
        });
    });

    it('the module carries the same relay-safe pattern and mint expression as the copies', function () {
        var mine = fs.readFileSync(MAIN_PATH, 'utf8');
        assert.ok(mine.indexOf('/^[\\w.\\-]{1,32}$/') > -1, 'the relay-safe pattern');
        assert.ok(mine.indexOf("crypto.randomBytes(3).toString('hex').toUpperCase()") > -1, 'the 6-hex mint');
    });
});

describe('#ERRREF lib/error-ref §03 — the registry', function () {

    it('lib/index.js registers it with a plain require (the lane binds it at load)', function () {
        assert.match(IDX_SRC, /errorRef\s*:\s*require\('\.\/error-ref'\)/);
        assert.doesNotMatch(IDX_SRC, /errorRef\s*:\s*_require\(/);
    });

    it('GinaLib declares `errorRef` with its mint', function () {
        var at = DTS_SRC.indexOf('interface GinaLib {');
        assert.ok(at > -1);
        var block = DTS_SRC.substring(at, DTS_SRC.indexOf('\n    }\n', at));
        assert.match(block, /\n\s+errorRef\s*:\s*\{[\s\S]*?mint\(supplied\?: string\): string;/);
    });
});
