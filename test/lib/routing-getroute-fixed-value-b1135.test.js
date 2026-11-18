'use strict';
/**
 * #B1135 — getRoute() read a fixed `param` value as a regular expression.
 *
 * On a GET rule, getRoute() decides which `param` values travel as query parameters by testing
 * each value against the url it composed. A fixed value (one that is not a `:placeholder`) was
 * compiled with `new RegExp(value)`, and a placeholder's own regex was built from its text without
 * escaping (in the first loop and in the extra-params loop). So a value holding regex
 * metacharacters was read as a pattern, not as text:
 *   - `label: "C++"`, `"(beta"`, `"[x"` or `"*New*"` threw a SyntaxError on every getRoute() call
 *     for the rule (the getUrl filter, self.redirect('<rule>'), forward()), and so did a value that
 *     starts with `:` without being a whole placeholder, such as `":-)"`;
 *   - `section: "a.c"` matched the url `/abc/:id` by accident, so the caller's `section` was
 *     dropped; `section: "a$"` missed the url `/a$/:id` it is written in (`$` read as an anchor), so
 *     the caller's `section` was appended.
 * The routing guide and llms.txt say a fixed value is looked for « as written ». A key in
 * `reservedParams` (`title`, `file`, `namespace`, `path`) is skipped before any regex, so
 * `title: "*Beta*"` never threw. Reproduced 2026-11-15 on develop, booted and in memory.
 *
 * The fix: a fixed value is looked for as written (`maskedUrl.indexOf(String(value)) > -1`), and the
 * two placeholder regexes are built from the value's text with its regex metacharacters escaped.
 *
 * Strategy: the REAL `lib/routing`, loaded through the framework helpers bootstrap (the
 * routing-getroute-url-choice-b374 shape), against a routing table in the shape `core/config.js`
 * hands it (`<rule>@<bundle>` keys, `method` set). The source text is compiled under its real file
 * name, so its relative requires resolve whichever copy the text comes from.
 *
 * Suites:
 *  01 — CONTROLS (hold before and after the fix)
 *  02 — a fixed value holding regex metacharacters composes instead of throwing
 *  03 — a fixed value is looked for as written
 *  04 — source pins (comment-stripped; the old regexes survive in `was:` comments only)
 *  05 — dist pins (lib/routing is in the browser bundle)
 *
 * Seams (red-first against pre-fix copies):
 *   GINA_B1135_ROUTING_SRC=<path>  the lib/routing/src/main.js text to load
 *   GINA_B1135_DIST_DIR=<path>     the dist/vendor/gina/js directory suite 05 reads
 * On pre-fix copies the fix arms fail and the CONTROL arms pass.
 *
 * Run standalone: node --test test/lib/routing-getroute-fixed-value-b1135.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var Module = require('module');
var FW     = require('../fw');

var REAL_SRC = path.join(FW, 'lib', 'routing', 'src', 'main.js');
var SRC      = process.env.GINA_B1135_ROUTING_SRC || REAL_SRC;
var DIST_DIR = process.env.GINA_B1135_DIST_DIR || path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js');

// -- real-module harness (node:test runs each file in its own process, so the global
//    injection below cannot leak into other test files) --
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module._initPaths();
require(path.join(FW, 'helpers'));                          // installs setContext/getContext, requireJSON …
require(path.join(FW, '..', '..', 'utils', 'prototypes'));  // installs JSON.clone

var src     = fs.readFileSync(path.resolve(SRC), 'utf8');
var routing = (function () {
    var m = new Module(REAL_SRC, null);
    m.filename = REAL_SRC;
    m.paths    = Module._nodeModulePaths(path.dirname(REAL_SRC));
    m._compile(src, REAL_SRC);
    return m.exports;                                       // the module exports a ready instance
})();

var BUNDLE = 'testb';
var WORD   = '/^\\w+$/';
var TABLE  = {
    // a fixed value outside reservedParams, on GET rules
    'lab@testb':     { method: 'GET',  url: '/lab/:id',     param: { control: 'render', id: ':id', label: 'C++' } },
    'paren@testb':   { method: 'GET',  url: '/paren/:id',   param: { control: 'render', id: ':id', label: '(beta' } },
    'brack@testb':   { method: 'GET',  url: '/brack/:id',   param: { control: 'render', id: ':id', label: '[x' } },
    'star@testb':    { method: 'GET',  url: '/star/:id',    param: { control: 'render', id: ':id', label: '*New*' } },
    'colon@testb':   { method: 'GET',  url: '/colon/:id',   param: { control: 'render', id: ':id', label: ':-)' } },
    'dot@testb':     { method: 'GET',  url: '/abc/:id',     param: { control: 'render', id: ':id', section: 'a.c' }, requirements: { section: WORD } },
    'dotlit@testb':  { method: 'GET',  url: '/a.c/:id',     param: { control: 'render', id: ':id', section: 'a.c' }, requirements: { section: WORD } },
    'dollar@testb':  { method: 'GET',  url: '/a$/:id',      param: { control: 'render', id: ':id', section: 'a$' }, requirements: { section: WORD } },
    // controls
    'title@testb':   { method: 'GET',  url: '/title/:id',   param: { control: 'render', id: ':id', title: '*Beta*' } },
    'plain@testb':   { method: 'GET',  url: '/plain/:id',   param: { control: 'render', id: ':id', label: 'plain' } },
    'post@testb':    { method: 'POST', url: '/post/:id',    param: { control: 'save', id: ':id', label: 'C++' } },
    'sect@testb':    { method: 'GET',  url: '/billing/:id', param: { control: 'render', id: ':id', section: 'billing' }, requirements: { section: WORD } },
    'code@testb':    { method: 'GET',  url: '/code/:id',    param: { control: 'render', id: ':id', code: 302 } },
    'popin@testb':   { method: 'GET',  url: '/popin/:id',   param: { control: 'render', id: ':id', isPopinContext: true } },
    'invoice@testb': { method: 'GET',  url: '/invoice/:id', param: { control: 'get', id: ':id' } },
    'logout@testb':  { method: 'GET',  url: '/logout/:timestamp,/logout', param: { control: 'logout', timestamp: ':timestamp' }, requirements: { timestamp: '/^\\d+$/' } },
    'search@testb':  { method: 'GET',  url: '/search',      param: { control: 'search' } },
    'widget@testb':  { method: 'GET',  url: '/widget/:id',  param: { control: 'render', id: ':id', mode: ':mode' }, requirements: { id: '/^\\d+$/', mode: '/^(alpha|beta)$/' } },
    'prefix@testb':  { method: 'GET',  url: '/k/:keyXyz',   param: { control: 'render', key: ':key', keyXyz: ':keyXyz' }, requirements: { key: WORD, keyXyz: WORD } }
};

process.gina = process.gina || {};                         // gna.js normally creates this; getRoute reads process.gina.PROXY_HOSTNAME
setContext('isProxyHost', false);
setContext('gina', {
    config: {
        env       : 'dev',
        bundle    : BUNDLE,
        getRouting: function () { return TABLE; },
        envConf   : {}
    }
});

/**
 * The url getRoute() composes; without a second argument, getRoute() is called with the rule alone.
 *
 * @inner
 * @param {string} rule - The rule name without its bundle
 * @param {object} [params]
 * @returns {string}
 */
function url(rule, params) {
    return ( arguments.length > 1 )
        ? routing.getRoute(rule + '@' + BUNDLE, params).url
        : routing.getRoute(rule + '@' + BUNDLE).url;
}

/**
 * Comment-stripped source: a `//` comment preceded by nothing or by whitespace.
 *
 * @inner
 * @param {string} text
 * @returns {string}
 */
function code(text) {
    return text.split('\n').map(function (l) { return l.replace(/(^|\s)\/\/.*$/, ''); }).join('\n');
}

/**
 * The number of times `needle` occurs in `hay`.
 *
 * @inner
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The number of matches of a global regular expression in `hay`.
 *
 * @inner
 * @param {string} hay
 * @param {RegExp} re - A regular expression with the `g` flag
 * @returns {number}
 */
function matchCount(hay, re) { return (hay.match(re) || []).length; }


describe('01 - CONTROLS: compositions the fix must leave as they were', function () {

    it('01.1 a reserved key is never tested (`title: "*Beta*"` composes on both sides of the fix)', function () {
        assert.equal(url('title', { id: 1 }), '/title/1');
    });

    it('01.2 a fixed value without metacharacters: not in the url, not passed, nothing appended', function () {
        assert.equal(url('plain', { id: 1 }), '/plain/1');
    });

    it('01.3 no params: the query loops do not run, the placeholder stays', function () {
        assert.equal(url('lab'), '/lab/:id');
    });

    it('01.4 a POST rule: the query loops do not run', function () {
        assert.equal(url('post', { id: 1 }), '/post/1');
    });

    it('01.5 a fixed value written in the url keeps the caller\'s value out of the query', function () {
        assert.equal(url('sect', { id: 1, section: 'x' }), '/billing/1');
        assert.equal(url('dotlit', { id: 1, section: 'x' }), '/a.c/1');
    });

    it('01.6 non-string fixed values (a number, a boolean) are read as their text', function () {
        assert.equal(url('code', { id: 1, code: 5 }), '/code/1?code=5');
        assert.equal(url('popin', { id: 1 }), '/popin/1');
    });

    it('01.7 the #B374 / #B943 / #B220 shapes', function () {
        assert.equal(url('invoice', { id: 'abc-123' }), '/invoice/abc-123');
        assert.equal(url('logout', { timestamp: '9' }), '/logout/9');
        assert.equal(url('logout', {}), '/logout');
        assert.equal(url('search', { q: 'gina', page: 2 }), '/search?q=gina&page=2');
        assert.equal(url('widget', { id: 7, mode: 'alpha' }), '/widget/7?mode=alpha');
        assert.equal(url('prefix', { key: 'a', keyXyz: 'b' }), '/k/b?key=a');
        assert.equal(url('invoice', { id: 'abc-123', extra: { a: 1 } }), '/invoice/abc-123?extra=%7B%22a%22%3A1%7D');
    });
});


describe('02 - #B1135: a fixed value holding regex metacharacters composes instead of throwing', function () {

    it('02.1 `label: "C++"` (was: SyntaxError « Nothing to repeat »)', function () {
        assert.equal(url('lab', { id: 1 }), '/lab/1');
    });

    it('02.2 `label: "(beta"` (was: SyntaxError « Unterminated group »)', function () {
        assert.equal(url('paren', { id: 1 }), '/paren/1');
    });

    it('02.3 `label: "[x"` (was: SyntaxError « Unterminated character class »)', function () {
        assert.equal(url('brack', { id: 1 }), '/brack/1');
    });

    it('02.4 `label: "*New*"` (was: SyntaxError « Nothing to repeat »)', function () {
        assert.equal(url('star', { id: 1 }), '/star/1');
    });

    it('02.5 `label: ":-)"`, a value that starts with `:` without being a placeholder (was: SyntaxError « Unmatched \')\' », the placeholder regex)', function () {
        assert.equal(url('colon', { id: 1 }), '/colon/1');
    });

    it('02.6 the caller passes the value of that key: it travels as a query parameter (was: SyntaxError)', function () {
        assert.equal(url('lab', { id: 1, label: 'y' }), '/lab/1?label=y');
    });
});


describe('03 - #B1135: a fixed value is looked for as written', function () {

    it('03.1 `section: "a.c"` is not in `/abc/:id`: the caller\'s `section` is appended (was: dropped, `.` read as any character)', function () {
        assert.equal(url('dot', { id: 1, section: 'x' }), '/abc/1?section=x');
    });

    it('03.2 `section: "a$"` is written in `/a$/:id`: the caller\'s `section` stays out (was: appended, `$` read as an anchor)', function () {
        assert.equal(url('dollar', { id: 1, section: 'x' }), '/a$/1');
    });
});


describe('04 - source pins: a fixed value as written, the placeholder regexes from the escaped text', function () {

    it('04.1 the first loop looks for a fixed value as written and escapes the placeholder (comment-stripped)', function () {
        var c = code(src);
        assert.equal(countOf(c, 'let _paramText = String(route.param[r]);'), 1, 'the value as text');
        assert.equal(countOf(c, 'let _paramEsc  = _paramText.replace('), 1, 'the escaped text');
        assert.equal(countOf(c, ': maskedUrl.indexOf(_paramText) > -1'), 1, 'a fixed value looked for as written');
        assert.equal(countOf(c, "? new RegExp('('+ _paramEsc +'/|'+ _paramEsc +'$)').test(maskedUrl)"), 1, 'the placeholder regex from the escaped text');
    });

    it('04.2 the extra-params loop escapes the placeholder on both sides of its regex', function () {
        var c = code(src);
        assert.equal(countOf(c, 'route.param[p].replace('), 2);
    });

    it('04.3 the regexes built from the raw value are gone from live code', function () {
        var c = code(src);
        assert.equal(countOf(c, 'new RegExp(route.param[r]).test(maskedUrl)'), 0, 'the fixed value read as a pattern');
        assert.equal(countOf(c, "new RegExp('('+ route.param[r] +'/|'+ route.param[r] +'$)')"), 0, 'the first loop\'s unescaped placeholder');
        assert.equal(countOf(c, "new RegExp('('+ route.param[p] +'/|'+ route.param[p] +'$)')"), 0, 'the extra-params loop\'s unescaped placeholder');
    });

    it('04.4 CONTROL: the comment stripping is not vacuous (the old regexes survive in the raw text)', function () {
        assert.ok(src.indexOf('new RegExp(route.param[r]).test(maskedUrl)') > -1, 'the raw text no longer names the old literal test: the stripping control cannot fire');
        assert.ok(src.indexOf("new RegExp('('+ route.param[p] +'/|'+ route.param[p] +'$)')") > -1, 'the raw text no longer names the old extra-params regex: the stripping control cannot fire');
    });
});


describe('05 - dist pins: the fix is in both browser bundles', function () {

    it('05.1 dist: gina.js carries the fixed value as written and the escaped placeholder regex', function () {
        var dist = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
        assert.ok(dist.indexOf(': maskedUrl.indexOf(_paramText) > -1') > -1, 'gina.js does not look for a fixed value as written (rebuild the bundle)');
        assert.ok(dist.indexOf("? new RegExp('('+ _paramEsc +'/|'+ _paramEsc +'$)').test(maskedUrl)") > -1, 'gina.js does not escape the placeholder (rebuild the bundle)');
    });

    it('05.2 dist: gina.min.js reads a value as text and escapes the extra-params placeholder; the old literal regex is gone', function () {
        var dist = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8');
        // Closure renames the locals: the shapes below hold whatever the names become.
        // Measured on the pre-fix bundle (develop d63836009): 0, 0 and 1.
        assert.ok(matchCount(dist, /String\([A-Za-z_$][\w$]*\.param\[[A-Za-z_$][\w$]*\]\)/g) > 0, 'gina.min.js does not read the value as text (rebuild the bundle)');
        assert.ok(matchCount(dist, /\.param\[[A-Za-z_$][\w$]*\]\.replace\(/g) > 0, 'gina.min.js does not escape the extra-params placeholder (rebuild the bundle)');
        assert.equal(matchCount(dist, /\(new RegExp\([A-Za-z_$][\w$]*\.param\[[A-Za-z_$][\w$]*\]\)\)\.test\(/g), 0, 'gina.min.js still compiles a fixed value as a pattern (rebuild the bundle)');
    });

    it('05.3 CONTROL: gina.min.js carries getRoute', function () {
        var dist = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8');
        assert.ok(dist.indexOf('RoutingHelper::getRoute') > -1, 'gina.min.js does not carry getRoute at all');
    });
});
