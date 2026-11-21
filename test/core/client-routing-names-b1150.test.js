'use strict';
/**
 * #B1150 — the navigation module reads placeholder names as the server does.
 *
 * The server reads a name as its letters, digits and underscores: `/:lang-code/x/:id` is `:lang`
 * holding the whole segment, so a route that binds `lang-code` in `param` refuses `/fr/x/42`. The
 * navigation module (`gina/nav`, `compileVariant`) compiled such a segment under the name
 * `lang-code`, so on that route it intercepted links the server refused. It now compiles a segment
 * only when it is a whole `:name` in that grammar; any other segment holding a `:` leaves its variant
 * uncompiled, as `page:number` already did, so the module does not intercept a link through that
 * route. The routing map served to the browser (core/server.js `buildClientRoutingAssets`) is
 * unchanged: it still keeps the `lang-code` binding (suite 01).
 *
 * Strategy: the shipped functions run as they are, brace-walked out of the sources (the
 * spa-nav-module.test.js composition). Seams: `GINA_SERVER_SRC=<a copy of core/server.js>` and
 * `GINA_NAV_SRC=<a copy of the nav plugin's main.js>` read other bytes.
 *
 * Suites:
 *  01 — the extraction and the controls (hold before and after the fix)
 *  02 — on a route binding `lang-code`, the navigation module leaves the variant uncompiled
 *       (fix-sensitive)
 *  03 — source pin (comment-stripped, fix-sensitive)
 *  04 — dist pin: the bundle carries the navigation module's test
 *
 * Red-first: run with `GINA_NAV_SRC` pointing at the file before this fix — suites 02 and 03.2 red,
 * the others green. Suite 04 reads the tree's own bundle: it is red on a tree whose bundle predates
 * the fix, whatever the seam.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var SERVER_SRC = fs.readFileSync(process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8');
var NAV_SRC    = fs.readFileSync(process.env.GINA_NAV_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/nav/main.js'), 'utf8');
var DIST_JS    = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

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
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
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

var BUILD_DECL = "function buildClientRoutingAssets(allRoutes) {";
var NAV_NEW    = "if ( !/^\\:\\w+$/.test(seg) ) {";
var NAV_OLD    = "!/^\\:[-_a-zA-Z0-9]+$/.test(seg)";

var build = new Function(extractFn(SERVER_SRC, BUILD_DECL) + '\nreturn buildClientRoutingAssets;')();
var EX = {
    safeDecode       : extractFn(NAV_SRC, 'var safeDecode = function(str) {'),
    parseRequirement : extractFn(NAV_SRC, 'var parseRequirement = function(requirement) {'),
    compileVariant   : extractFn(NAV_SRC, 'var compileVariant = function(url, route) {'),
    getCompiled      : extractFn(NAV_SRC, 'var getCompiled = function() {'),
    matchUrl         : extractFn(NAV_SRC, 'var matchUrl = function(pathname) {')
};
var parse   = new Function('return (' + EX.parseRequirement + ');')();
var compile = new Function('parseRequirement', 'return (' + EX.compileVariant + ');')(parse);

/**
 * The navigation module's matcher over a served routing table (spa-nav-module.test.js's composition).
 *
 * @inner
 * @param {object} table - the served routing map
 * @returns {function(string): ?object}
 */
function makeMatcher(table) {
    var fakeWindow  = { gina: { config: { bundle: 'b', routing: table } } };
    var getCompiled = new Function('window', '_compiled', '_compiledFor', 'compileVariant', 'return (' + EX.getCompiled + ');')(fakeWindow, null, null, compile);
    var safeDecode  = new Function('return (' + EX.safeDecode + ');')();
    return new Function('getCompiled', 'safeDecode', 'return (' + EX.matchUrl + ');')(getCompiled, safeDecode);
}

var ROUTES = {
    'hl@b': { method: 'GET', bundle: 'b', url: '/:lang-code/x/:id', negotiate: true, param: { control: 'h', lang: ':lang', id: ':id' } },
    'hc@b': { method: 'GET', bundle: 'b', url: '/:lang-code/x/:id', negotiate: true, param: { control: 'h', 'lang-code': ':lang-code', id: ':id' } },
    'us@b': { method: 'GET', bundle: 'b', url: '/:lang_code/x/:id', negotiate: true, param: { control: 'h', lang_code: ':lang_code', id: ':id' } }
};
var FULL = build(JSON.clone(ROUTES)).full;

/**
 * The matcher over one rule of the served map.
 *
 * @inner
 * @param {string} rule
 * @returns {function(string): ?object}
 */
function only(rule) {
    var one = {};
    one[rule] = FULL[rule];
    return makeMatcher(one);
}


// ─── 01 — the extraction and the controls ─────────────────────────────────────

describe('01 - #B1150: the extraction and the controls', function () {

    it('01.1  the builder and the navigation functions are extracted', function () {
        assert.equal(typeof build, 'function');
        assert.equal(typeof compile, 'function');
        assert.ok(FULL && typeof FULL === 'object' && FULL['us@b'], 'the builder returns the served map');
    });

    it('01.2  `:lang_code`: the map keeps both bindings', function () {
        assert.deepEqual(FULL['us@b'].param, { lang_code: ':lang_code', id: ':id' });
    });

    it('01.3  `:lang_code`: the navigation module matches /fr/x/42 and refuses /fr/y/42', function () {
        var m = only('us@b')('/fr/x/42');
        assert.ok(m && m.rule === 'us@b', JSON.stringify(m));
        assert.equal(only('us@b')('/fr/y/42'), null);
    });

    it('01.4  the served map keeps the `lang-code` binding the route declares (unchanged)', function () {
        assert.deepEqual(FULL['hc@b'].param, { 'lang-code': ':lang-code', id: ':id' });
    });

    it('01.5  bound as `lang`, the variant was never compiled and /fr/x/42 is not intercepted', function () {
        assert.deepEqual(FULL['hl@b'].param, { id: ':id' });
        assert.equal(compile('/:lang-code/x/:id', ROUTES['hl@b']), null);
        assert.equal(only('hl@b')('/fr/x/42'), null);
    });
});


// ─── 02 — the navigation module ────────────────────────────────────────────────

describe('02 - #B1150: on a route binding `lang-code`, the navigation module leaves the variant uncompiled', function () {

    it('02.1  compileVariant returns null for `/:lang-code/x/:id` bound as `lang-code`', function () {
        assert.equal(compile('/:lang-code/x/:id', ROUTES['hc@b']), null);
    });

    it('02.2  over the served map, which keeps that binding, the matcher does not intercept /fr/x/42', function () {
        assert.equal(only('hc@b')('/fr/x/42'), null);
    });
});


// ─── 03 — source pin ───────────────────────────────────────────────────────────

describe('03 - #B1150: source', function () {

    var srv = stripComments(SERVER_SRC), nav = stripComments(NAV_SRC);

    it('03.1  control: the strip keeps both declarations', function () {
        assert.equal(count(srv, BUILD_DECL), 1);
        assert.equal(count(nav, 'var compileVariant = function(url, route) {'), 1);
    });

    it('03.2  the navigation module compiles a whole `:name` segment only', function () {
        assert.equal(count(nav, NAV_NEW), 1);
        assert.equal(count(nav, NAV_OLD), 0);
        assert.equal(count(NAV_SRC, NAV_OLD), 1, 'control: the old line is kept as a comment, which the strip removed');
    });
});


// ─── 04 — dist pin ─────────────────────────────────────────────────────────────

describe('04 - #B1150: the browser bundle carries the navigation module\'s test', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries the navigation module (control) and the new test', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, 'var compileVariant = function(url, route) {'), 1, 'control: the navigation module must be in the bundle');
        assert.equal(count(dist, NAV_NEW), 1, 'the rebuilt bundle must carry the new test');
    });
});
