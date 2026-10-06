'use strict';
/**
 * #B688 — a `:placeholder` in `param.path`, `param.title` or `param.namespace` takes its value
 * VERBATIM, on the request path and through `getRoute()`.
 *
 * `lib/routing` substitutes a route's placeholder value into three `param` fields at six sites:
 * on the request path, `fitsWithRequirements` writes the URL segment (`.replace(regex, urlVal)`),
 * and `checkRouteParams` writes a `getRoute()` parameter or the matched request value
 * (`.replace( regex, params[variable])`). Both were STRING replacements, so the replacement
 * patterns of `String.prototype.replace` expanded inside the value: `` $` `` inserted the text
 * before the placeholder, `$&` the placeholder itself, `$'` the text after it, `$$` one `$`.
 * A request to `/user/$%60` rewrote `"title": "User :id"` to `User User ` and
 * `"path": "/users/:id/edit"` to `/users//users//edit`. The URL itself, and `param.file`,
 * already went through the `replacement` function and stayed verbatim.
 *
 * The same string replacement in `checkRouteParams` dropped the `/` its regex consumes
 * (`(:id/|:id$)`): `getRoute()` built `/users/42edit` from `/users/:id/edit`. The fix routes
 * those three sites through `replacement`, which restores the `/`, as it does for the URL.
 *
 * Strategy: the REAL `lib/routing` (`getRoute`, `compareUrls`), loaded through the framework's
 * helpers bootstrap (the routing-inherited-keys-b650 shape) — no replica to drift.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — getRoute: `$`-patterns land verbatim (fix-sensitive)
 *  03 — getRoute keeps the `/` after a `:variable/` placeholder (fix-sensitive)
 *  04 — request path (compareUrls → req.routing.param): `$`-patterns land verbatim (fix-sensitive)
 *  05 — source pins: no string replacement on the three fields (comment-stripped)
 *  06 — dist pin: the browser bundle carries the fixed sites (lib/routing is bundled)
 *
 * Red-first: suites 02–06 were run against the unfixed tree before the fix landed (develop
 * `4813361f7`, 2026-10-06): 14 red, 8 green. Suite 01 holds on both revisions, and so do the
 * `a$1b` and `$<n>` arms of suite 04: the request-path regex (`:id`) has no capture group, so
 * `replace` already left `$1` and `$<n>` literal there. Every other arm was red.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    'titled@b': { method: 'GET', url: '/user/:id', bundle: 'b',
                  param: { control: 'show', id: ':id', title: 'User :id', namespace: 'ns-:id', path: '/users/:id/edit' } },
    'tail@b':   { method: 'GET', url: '/item/:id', bundle: 'b',
                  param: { control: 'show', id: ':id', title: ':id', namespace: ':id', path: '/items/:id' } }
};
var PRISTINE = JSON.stringify(TABLE);
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));

// Every replacement pattern String.prototype.replace knows, plus a numbered group reference.
var DOLLAR_VALUES = ['$`', '$&', "$'", 'a$1b', '$$', '$<n>'];

/**
 * Match `url` against a rule the way the engine does (server.js builds this route description).
 * The URL is built by concatenation: a string replacement would expand the very patterns under test.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} value - the URL segment that fills `:id`
 * @returns {Promise<{past: boolean, param: object}>}
 */
async function match(name, value) {
    var rule = TABLE[name];
    var url  = rule.url.split(':id').join('') + value;
    var req  = { url: url, method: 'GET', headers: {}, params: { 0: url }, get: {} };
    var params = {
        method: rule.method, control: rule.param.control, requirements: rule.requirements, url: url,
        rule: name, param: JSON.clone(rule.param), middleware: [], bundle: 'b'
    };
    var out = await routing.compareUrls(params, rule.url, req, {}, function () {});
    return { past: !!(out && out.past), param: (req.routing && req.routing.param) || {} };
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

/**
 * Count the matches of a global regex.
 *
 * @inner
 * @param {string} s
 * @param {RegExp} re - must carry the `g` flag
 * @returns {number}
 */
function count(s, re) {
    return (s.match(re) || []).length;
}

// The defective forms, and the fixed ones (the six sites).
var OLD_FITS  = /\.replace\(regex, urlVal\)/g;
var OLD_CRP   = /\.replace\( regex, params\[variable\]\)/g;
var NEW_FITS  = /params\.param\.(path|namespace|title) = params\.param\.\1\.replace\(regex, function \(\) \{ return urlVal; \}\);/g;
var NEW_CRP   = /route\.param\.(path|title|namespace) = route\.param\.\1\.replace\( regex, replacement \);/g;


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B688: the instrument and the controls (hold before and after the fix)', function () {

    it('01.1  a plain value fills every field on both paths (control)', async function () {
        var r = routing.getRoute('titled@b', { id: '42' });
        assert.equal(r.param.title, 'User 42');
        assert.equal(r.param.namespace, 'ns-42');
        var m = await match('titled@b', '42');
        assert.equal(m.past, true);
        assert.equal(m.param.title, 'User 42');
        assert.equal(m.param.namespace, 'ns-42');
        assert.equal(m.param.path, '/users/42/edit');
    });

    it('01.2  the URL already takes a `$` value verbatim: the values reach the module intact (the instrument)', function () {
        DOLLAR_VALUES.forEach(function (v) {
            var r = routing.getRoute('titled@b', { id: v });
            assert.equal(r.url.split('?')[0], '/user/' + v, 'route.url for ' + JSON.stringify(v));
        });
    });

    it('01.3  each `$` value matches the rule on the request path', async function () {
        for (var i = 0; i < DOLLAR_VALUES.length; i++) {
            var m = await match('titled@b', DOLLAR_VALUES[i]);
            assert.equal(m.past, true, JSON.stringify(DOLLAR_VALUES[i]) + ' must match /user/:id');
        }
    });

    it('01.4  the routing table is never written (both paths)', async function () {
        routing.getRoute('titled@b', { id: '$`' });
        await match('tail@b', '$`');
        assert.equal(JSON.stringify(TABLE), PRISTINE);
    });
});


// ─── 02 — getRoute: verbatim ──────────────────────────────────────────────────

describe('02 - #B688: getRoute substitutes a `$` value verbatim', function () {

    DOLLAR_VALUES.forEach(function (v) {
        it('02  id=' + JSON.stringify(v) + ' lands as written in title, namespace and path', function () {
            var r = routing.getRoute('titled@b', { id: v });
            assert.equal(r.param.title, 'User ' + v);
            assert.equal(r.param.namespace, 'ns-' + v);
            assert.equal(r.param.path, '/users/' + v + '/edit');
            var t = routing.getRoute('tail@b', { id: v });
            assert.equal(t.param.title, v);
            assert.equal(t.param.namespace, v);
            assert.equal(t.param.path, '/items/' + v);
        });
    });
});


// ─── 03 — getRoute: the `/` ───────────────────────────────────────────────────

describe('03 - #B688: getRoute keeps the `/` after a `:variable/` placeholder', function () {

    it('03.1  `/users/:id/edit` with id 42 gives `/users/42/edit` (was `/users/42edit`)', function () {
        assert.equal(routing.getRoute('titled@b', { id: '42' }).param.path, '/users/42/edit');
    });

    it('03.2  a placeholder at the end needs no `/`: `/items/:id` gives `/items/42` (control)', function () {
        assert.equal(routing.getRoute('tail@b', { id: '42' }).param.path, '/items/42');
    });
});


// ─── 04 — request path: verbatim ──────────────────────────────────────────────

describe('04 - #B688: the request path substitutes a URL segment verbatim', function () {

    DOLLAR_VALUES.forEach(function (v) {
        it('04  /user/' + v + ' lands as written in req.routing.param', async function () {
            var m = await match('titled@b', v);
            assert.equal(m.param.title, 'User ' + v);
            assert.equal(m.param.namespace, 'ns-' + v);
            assert.equal(m.param.path, '/users/' + v + '/edit');
            var t = await match('tail@b', v);
            assert.equal(t.param.title, v);
            assert.equal(t.param.namespace, v);
            assert.equal(t.param.path, '/items/' + v);
        });
    });
});


// ─── 05 — source pins ─────────────────────────────────────────────────────────

describe('05 - #B688: source — no string replacement on param.path, title or namespace', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('05.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.ok(live.indexOf('var checkRouteParams = function(route, params)') > -1, 'the strip must keep checkRouteParams');
        assert.ok(live.indexOf('var replacement = function(matched)') > -1, 'the strip must keep replacement');
        assert.ok(count(raw, OLD_FITS) >= 1, 'the raw source keeps the old form in a comment, so 05.2 cannot pass on a broken strip');
        assert.equal(stripComments('    // was: a.replace(regex, urlVal);\n    y\n').indexOf('urlVal'), -1, 'the strip must remove a full-line comment');
    });

    it('05.2  live code carries no `.replace(regex, urlVal)` and no `.replace( regex, params[variable])`', function () {
        assert.equal(count(live, OLD_FITS), 0);
        assert.equal(count(live, OLD_CRP), 0);
    });

    it('05.3  the three request-path sites use a function replacer, the three checkRouteParams sites `replacement`', function () {
        assert.equal(count(live, NEW_FITS), 3);
        assert.equal(count(live, NEW_CRP), 3);
    });
});


// ─── 06 — dist pin ────────────────────────────────────────────────────────────

describe('06 - #B688: the browser bundle carries the fixed sites', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('06.1  the unminified bundle carries lib/routing (control) and the six fixed sites, none of the old forms', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('var checkRouteParams = function(route, params)') > -1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, NEW_FITS), 3, 'the rebuilt bundle must carry the three function replacers');
        assert.equal(count(dist, NEW_CRP), 3, 'the rebuilt bundle must carry the three `replacement` sites');
        assert.equal(count(dist, OLD_FITS) + count(dist, OLD_CRP), 0, 'the rebuilt bundle must carry no string replacement there');
    });
});
