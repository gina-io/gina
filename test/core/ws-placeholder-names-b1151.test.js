'use strict';
/**
 * #B1151 — a WebSocket route reads a placeholder's name as an HTTP route does.
 *
 * Isaac's WebSocket matcher (core/server.isaac.js `_wsMatchParam`) keyed a capture by the whole rest
 * of its segment: `/live/:lang-code` exposed `request.params['lang-code']`, while the same URL on an
 * HTTP route binds `lang`. The name is now the segment's letters, digits and underscores after the
 * `:`, and the capture is still the whole segment. A segment with no name after its `:`, or with two
 * or more placeholders, captures nothing: it is compared as written, as on HTTP.
 *
 * Strategy: the shipped matcher runs as it is, brace-walked out of the source and given a fake
 * server holding one pattern. Seam: `GINA_ISAAC_SRC=<a copy of core/server.isaac.js>` reads other
 * bytes.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — the name (fix-sensitive)
 *  03 — a nameless or multi-placeholder segment is compared as written (fix-sensitive)
 *  04 — source pins (comment-stripped, fix-sensitive)
 *
 * Red-first: run with `GINA_ISAAC_SRC` pointing at the file before this fix — suites 02, 03 and 04.2
 * red, the others green. core/server.isaac.js is not in the browser bundle: no dist pin.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW        = require('../fw');
var commentStrip = require('../strip-comments');
var ISAAC_SRC = fs.readFileSync(process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js'), 'utf8');

/**
 * Brace-walk extraction of a function from shipped source (test/core/spa-nav-module.test.js's
 * extractFn): the declaration must occur exactly once and the walk must close balanced.
 *
 * @inner
 * @param {string} src
 * @param {string} decl - the declaration, up to and including its opening brace
 * @returns {string} the `function(...) {...}` slice
 */
function extractFn(src, decl) {
    var i = src.indexOf(decl);
    if (i < 0) { throw new Error('declaration not found: ' + decl); }
    if (src.indexOf(decl, i + 1) > -1) { throw new Error('declaration not unique: ' + decl); }
    var j = i, depth = 0, started = false;
    for (; j < src.length; j++) {
        if (src[j] === '{') { depth++; started = true; }
        else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    if (!(started && depth === 0)) { throw new Error('unbalanced braces walking: ' + decl); }
    return src.substring(i + decl.indexOf('function'), j);
}

/**
 * The source with its comments removed: block comments and full-line `//` comments.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return commentStrip.lines(s);
}

/**
 * Count the occurrences of a literal.
 *
 * @inner
 * @param {string} s
 * @param {string} needle
 * @returns {number}
 */
function count(s, needle) {
    return s.split(needle).length - 1;
}

/**
 * A global pattern matching the given literals in order, with only whitespace between them.
 *
 * @inner
 * @param {Array<string>} parts
 * @returns {RegExp}
 */
function seq(parts) {
    return new RegExp(parts.map(function (p) { return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('\\s*'), 'g');
}

/**
 * Count the matches of a global pattern.
 *
 * @inner
 * @param {string} s
 * @param {RegExp} re
 * @returns {number}
 */
function countRe(s, re) {
    return (s.match(re) || []).length;
}

var DECL      = "server._wsMatchParam = function(pathname) {";
var NAME      = "var _wsName = /^:(\\w+)/.exec(pat);";
var WRITE     = "params[_wsName[1]] = decodeURIComponent(reqSegs[s]);";
var SKIP      = "if ( !_wsName || pat.match(/:\\w+/g).length > 1 ) {";
var OLD_WRITE = "params[pat.substring(1)] = decodeURIComponent(reqSegs[s]);";

var WS_FN = extractFn(ISAAC_SRC, DECL);

/**
 * The shipped matcher over one registered pattern.
 *
 * @inner
 * @param {string} pattern
 * @returns {function(string): ?{handler: function, params: object, options: *}}
 */
function matcher(pattern) {
    var server = { _wsParamHandlers: [{ pattern: pattern, segments: pattern.split('/'), handler: function h() {}, options: null }] };
    return new Function('server', 'return (' + WS_FN + ');')(server);
}

/**
 * The params of a match, or null.
 *
 * @inner
 * @param {string} pattern
 * @param {string} pathname
 * @returns {?object}
 */
function paramsOf(pattern, pathname) {
    var m = matcher(pattern)(pathname);
    return m ? m.params : null;
}


// ─── 01 — the controls ─────────────────────────────────────────────────────────

describe('01 - #B1151: the controls', function () {

    it('01.1  `:room` captures its segment; another path and an empty segment are refused', function () {
        assert.deepEqual(paramsOf('/live/:room', '/live/abc'), { room: 'abc' });
        assert.equal(paramsOf('/live/:room', '/elsewhere/abc'), null);
        assert.equal(paramsOf('/live/:room', '/live/'), null);
    });

    it('01.2  a capture is decoded, and two plain names capture two segments', function () {
        assert.deepEqual(paramsOf('/live/:room', '/live/a%20b'), { room: 'a b' });
        assert.deepEqual(paramsOf('/room/:id/user/:uid', '/room/7/user/42'), { id: '7', uid: '42' });
    });
});


// ─── 02 — the name ─────────────────────────────────────────────────────────────

describe('02 - #B1151: the name is the letters, digits and underscores after the colon', function () {

    it('02.1  `/live/:lang-code` exposes `lang`, holding the whole segment', function () {
        assert.deepEqual(paramsOf('/live/:lang-code', '/live/fr'), { lang: 'fr' });
    });

    it('02.2  `/live/:id.json` exposes `id`, holding the whole segment', function () {
        assert.deepEqual(paramsOf('/live/:id.json', '/live/42.json'), { id: '42.json' });
    });
});


// ─── 03 — compared as written ──────────────────────────────────────────────────

describe('03 - #B1151: a nameless or multi-placeholder segment is compared as written', function () {

    it('03.1  `:a-:b` refuses a value and matches its own text, capturing nothing', function () {
        assert.equal(paramsOf('/live/:a-:b', '/live/x-y'), null);
        assert.deepEqual(paramsOf('/live/:a-:b', '/live/:a-:b'), {});
    });

    it('03.2  a lone `:` refuses a value and matches its own text, capturing nothing', function () {
        assert.equal(paramsOf('/live/:', '/live/x'), null);
        assert.deepEqual(paramsOf('/live/:', '/live/:'), {});
    });
});


// ─── 04 — source pins ──────────────────────────────────────────────────────────

describe('04 - #B1151: source', function () {

    var live = stripComments(ISAAC_SRC);

    it('04.1  control: the strip keeps the matcher', function () {
        assert.equal(count(live, DECL), 1);
    });

    it('04.2  the name is derived, a nameless or multi-placeholder segment is skipped, and the capture is keyed by the name', function () {
        assert.equal(count(live, NAME), 1);
        assert.equal(count(live, SKIP), 1);
        assert.equal(count(live, WRITE), 1);
        assert.equal(count(live, OLD_WRITE), 0, 'no capture may be keyed by the rest of the segment');
    });
});
