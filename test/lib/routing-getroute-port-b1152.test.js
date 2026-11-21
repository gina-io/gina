'use strict';
/**
 * #B1152 — `getRoute()`'s « placeholder not defined » warning tells a port from a placeholder.
 *
 * After composing a route's URL, `getRoute()` (lib/routing) warns when the URL still holds a `:`,
 * skipping a `host:port/` value with `/\:d+\//`. That pattern reads a literal `d`: a value holding
 * `host:3132/` was reported as a missing placeholder, and an unfilled placeholder named `d` was not.
 * The skip now reads `/\:\d+\//`.
 *
 * Strategy: the REAL lib/routing `getRoute()` through the framework's helpers bootstrap, with
 * `console.warn` recorded around each call (lib/routing wraps it once, at load). Seam:
 * `B1152_FW=<framework dir>` loads another tree's framework, for its pins AND its arms.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — the fix (fix-sensitive)
 *  03 — source pin (comment-stripped, fix-sensitive)
 *  04 — dist pin (lib/routing is bundled)
 *
 * Red-first: run with `B1152_FW` pointing at the tree before this fix — suites 02, 03.2 and 04 red,
 * the others green. Suite 04 stays red on a fixed source until the browser bundle is rebuilt.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B1152_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    'go@b': { method: 'GET', url: '/go', bundle: 'b', param: { control: 'go' } },
    'dd@b': { method: 'GET', url: '/x/:d/y', bundle: 'b', param: { control: 'x', d: ':d' } },
    'ee@b': { method: 'GET', url: '/x/:e/y', bundle: 'b', param: { control: 'x', e: ':e' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var commentStrip = require('../strip-comments');

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

var FITS_DECL = "var fitsWithRequirements = async function(";
var NEW_SKIP  = "&& !/\\:\\d+\\//.test(route.url)";
var OLD_SKIP  = "&& !/\\:d+\\//.test(route.url)";

/**
 * Compose `rule` with `params` and count the « placeholder not defined » warnings it logs.
 *
 * @inner
 * @param {string} rule
 * @param {object} params
 * @returns {{url: ?string, threw: ?string, warns: number}}
 */
function compose(rule, params) {
    var warns = [], realWarn = console.warn, url = null, threw = null;
    console.warn = function () {
        warns.push(Array.prototype.map.call(arguments, function (a) { return (a && a.message) || String(a); }).join(' '));
    };
    try {
        var r = routing.getRoute(rule, params);
        url = r && r.url;
    } catch (e) {
        threw = String((e && e.message) || e);
    } finally {
        console.warn = realWarn;
    }
    return { url: url, threw: threw, warns: warns.filter(function (w) { return /placeholder not defined/.test(w); }).length };
}


// ─── 01 — the controls ─────────────────────────────────────────────────────────

describe('01 - #B1152: the controls', function () {

    it('01.1  a value holding `://` is skipped: no warning', function () {
        var r = compose('go@b', { next: 'https://localhost:3132/back' });
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.warns, 0, r.url);
    });

    it('01.2  an unfilled placeholder named `e` warns once', function () {
        var r = compose('ee@b', {});
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.warns, 1, r.url);
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B1152: a port is not a placeholder, and a placeholder named `d` is one', function () {

    it('02.1  a value holding `host:port/` gives no warning', function () {
        var r = compose('go@b', { next: 'localhost:3132/back' });
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.warns, 0, r.url);
    });

    it('02.2  an unfilled placeholder named `d` warns once', function () {
        var r = compose('dd@b', {});
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.warns, 1, r.url);
    });
});


// ─── 03 — source pin ───────────────────────────────────────────────────────────

describe('03 - #B1152: source', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('03.1  control: the strip keeps live code', function () {
        assert.equal(count(live, FITS_DECL), 1);
    });

    it('03.2  the skip reads digits', function () {
        assert.equal(count(live, NEW_SKIP), 1);
        assert.equal(count(live, OLD_SKIP), 0, 'the literal-`d` skip must not be live');
        assert.equal(count(raw, OLD_SKIP), 1, 'control: the old line is kept as a comment, which the strip removed');
    });
});


// ─── 04 — dist pin ─────────────────────────────────────────────────────────────

describe('04 - #B1152: the browser bundle carries the skip', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries lib/routing (control) and the new skip', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, FITS_DECL), 1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, NEW_SKIP), 1, 'the rebuilt bundle must carry the new skip');
    });
});
