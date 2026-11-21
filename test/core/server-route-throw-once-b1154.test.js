'use strict';
/**
 * #B1154 — a route matcher that throws answers the request once.
 *
 * The route loop of core/server.js calls lib/routing's `compareUrls` for each rule in a try block;
 * a throw answers 500 « Rule [ <rule> ] needs your attention » and breaks out of the loop. The loop
 * left `matched` false, so the 404 after it ran as well and logged a second error line, with a ref of
 * its own, for the same request. A flag set in the catch now returns before the 405 and the 404, and
 * the route-match timeline entry of a development request reads 500 for it (it read 404).
 *
 * Strategy: source pins on the comment-stripped server.js (the route loop needs a booted bundle to
 * run; the live reading of the double line is in the routing cluster's measurement record). Seam:
 * `GINA_SERVER_SRC=<a copy of core/server.js>` reads other bytes (for example the file before this
 * fix).
 *
 * Suites:
 *  01 — the instrument: the strip, and the loop's catch (hold before and after the fix)
 *  02 — the flag is declared before the loop and set in the catch, before its break (fix-sensitive)
 *  03 — the early return sits after the route-match timeline and before the 405 and the 404, and
 *       the timeline entry reads 500 after a matcher throw (fix-sensitive)
 *
 * Red-first: run with `GINA_SERVER_SRC` pointing at the file before this fix — suites 02 and 03 red,
 * 01 green. core/server.js is not in the browser bundle: no dist pin.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var commentStrip = require('../strip-comments');
var SERVER_SRC = fs.readFileSync(process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8');

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

var CATCH  = "throwError(res, 500, 'Internal server error.\\nRule [ '+name+' ] needs your attention.\\n'+ err.stack);";
var DECL   = "var _routeMatchFailed = false;";
var SET    = "_routeMatchFailed = true;";
var GUARD  = "if ( _routeMatchFailed ) {";
var M405   = "if (!matched && _methodMismatch405msg) {";
var M404   = "return throwError(res, 404, 'Page not found: \\n' + pathname, next);";
var LOOP   = "isRoute = await routingLib.compareUrls(params, routing[name].url, req, res, next);";
var ALLOW  = "var _methodMismatchAllow = [];";
var FI     = "detail: matched ? ('rule: '";
var FI_NEW = "detail: matched ? ('rule: ' + (req.routing && req.routing.rule || '?')) : (_routeMatchFailed ? '500' : '404')";
var FI_OLD = "detail: matched ? ('rule: ' + (req.routing && req.routing.rule || '?')) : '404'";

var live = stripComments(SERVER_SRC);


// ─── 01 — the instrument ───────────────────────────────────────────────────────

describe('01 - #B1154: the instrument', function () {

    it('01.1  the strip removes a full-line comment and keeps code', function () {
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1);
        assert.equal(count(live, LOOP), 1, 'the loop\'s compareUrls call must be live, once');
    });

    it('01.2  the loop\'s catch answers 500 naming the rule, once, and the 405 and 404 lines are live once', function () {
        assert.equal(count(live, CATCH), 1);
        assert.equal(count(live, M405), 1);
        assert.equal(count(live, M404), 1);
        assert.equal(count(live, FI), 1, 'the route-match timeline entry must be live, once');
    });
});


// ─── 02 — the flag ─────────────────────────────────────────────────────────────

describe('02 - #B1154: the flag is declared before the loop and set in the catch', function () {

    it('02.1  declared once, after the 405 Allow list and before the loop', function () {
        assert.equal(count(live, DECL), 1);
        var allow = live.indexOf(ALLOW), decl = live.indexOf(DECL), loop = live.indexOf(LOOP);
        assert.ok(allow > -1 && decl > allow && loop > decl, 'allow ' + allow + ' decl ' + decl + ' loop ' + loop);
    });

    it('02.2  set right after the catch\'s 500, before its break', function () {
        assert.equal(countRe(live, seq([CATCH, SET])), 1, 'the catch must set the flag right after the 500');
        var c = live.indexOf(CATCH), s = live.indexOf(SET, c), b = live.indexOf('break;', c);
        assert.ok(c > -1 && s > c && b > s, 'catch ' + c + ' set ' + s + ' break ' + b);
    });
});


// ─── 03 — the early return ─────────────────────────────────────────────────────

describe('03 - #B1154: the early return precedes the 405 and the 404', function () {

    it('03.1  `if ( _routeMatchFailed ) { return; }` is live once', function () {
        assert.equal(countRe(live, seq([GUARD, 'return;', '}'])), 1);
    });

    it('03.2  it sits after the route-match timeline, before the 405 and the 404', function () {
        var fi = live.indexOf(FI), g = live.indexOf(GUARD), m405 = live.indexOf(M405), m404 = live.indexOf(M404);
        assert.ok(fi > -1 && g > fi && m405 > g && m404 > m405, 'timeline ' + fi + ' guard ' + g + ' 405 ' + m405 + ' 404 ' + m404);
    });

    it('03.3  the route-match timeline entry reads 500 after a matcher throw, 404 otherwise', function () {
        assert.equal(count(live, FI_NEW), 1);
        assert.equal(count(live, FI_OLD), 0, 'the entry that always read 404 must not be live');
        assert.equal(count(SERVER_SRC, FI_OLD), 1, 'control: the old line is kept as a comment, which the strip removed');
    });
});
