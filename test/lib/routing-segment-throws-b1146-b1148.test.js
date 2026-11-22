'use strict';
/**
 * #B1146 + #B1148 — a route URL segment that holds a `:` with no name after it, or that is not a
 * valid regular expression, no longer makes the route matcher throw.
 *
 * `fitsWithRequirements` (lib/routing) reads a segment's placeholder names with `/\:\w+/g` and
 * compiles the segment into a `g` regular expression for the path, namespace and title rewrites. A
 * segment holding a `:` with no name after it (`/t/12:`) gave a null match whose `length` threw; a
 * segment that is not a valid regular expression (`/r/:id)`, `/r/[:id`) threw « Invalid regular
 * expression ». Either throw reached the route loop as a 500 naming the rule, on every request that
 * reached the rule, and no later rule was tried. A nameless `:` now returns false (the segment
 * matches only a request carrying it as written), and the segment is escaped before it is compiled,
 * so the rewrites replace its own text, literally.
 *
 * Strategy: the REAL lib/routing (`compareUrls`), loaded through the framework's helpers bootstrap
 * (the routing-delete-partial-requirements-b956 shape), driven as core/server.js drives it. Seam:
 * `B1146_FW=<framework dir>` loads another tree's framework (for example the tree before this fix),
 * for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — #B1146: a `:` with no name after it (fix-sensitive)
 *  03 — #B1148: a segment that is not a valid regular expression (fix-sensitive)
 *  04 — #B1148: the rewrites replace the segment's own text (04.2 fix-sensitive)
 *  05 — source pins (comment-stripped, fix-sensitive)
 *  06 — dist pin: the unminified browser bundle carries both lines (lib/routing is bundled)
 *
 * Red-first: run with `B1146_FW` pointing at the tree before this fix — suites 02, 03, 04.2, 05.2,
 * 05.3 and 06 red, the others green. Suite 06 stays red on a fixed source until the browser bundle
 * is rebuilt.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B1146_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    // #B1146: a segment holding a `:` with no name after it, and the plain shape (the known positive)
    't_lone@b':   { method: 'GET', url: '/t/12:', bundle: 'b', param: { control: 't' } },
    't_plain@b':  { method: 'GET', url: '/t/:id', bundle: 'b', param: { control: 't', id: ':id' } },
    // #B1148: segments that are not valid regular expressions, and the plain shape
    'rx_paren@b': { method: 'GET', url: '/r/:id)', bundle: 'b', param: { control: 'r', id: ':id' } },
    'rx_brack@b': { method: 'GET', url: '/r/[:id', bundle: 'b', param: { control: 'r', id: ':id' } },
    'rx_plain@b': { method: 'GET', url: '/r/:id', bundle: 'b', param: { control: 'r', id: ':id' } },
    // #B1148: a valid regular expression whose `.` matched any character in the title rewrite
    'feed@b':     { method: 'GET', url: '/feed/:id.json', bundle: 'b', param: { control: 'feed', id: ':id', title: 'Feed :id.json, not :idXjson' } },
    'feed_ctl@b': { method: 'GET', url: '/feedc/:id.json', bundle: 'b', param: { control: 'feed', id: ':id', title: 'Feed :id.json' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var commentStrip = require('../strip-comments');

/**
 * Match a raw request path against a rule as core/server.js does: the raw path in `req.url`, its
 * `safeDecodeURI` form in `params.url`. A throw is caught and returned, never rethrown, so a pre-fix
 * run fails its arm instead of stopping the file.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} raw - the raw request path
 * @returns {Promise<{past: boolean, threw: ?string, params: object, bag: object, param: object}>}
 *   `params` is `req.params` minus its index-0 entry, `bag` the method's data bag after the match,
 *   `param` the route's per-request `param` copy after the rewrites
 */
async function match(name, raw) {
    var rule   = TABLE[name];
    var method = rule.method.toLowerCase();
    var req    = { url: raw, method: rule.method, headers: {}, params: { 0: raw } };
    req[method] = {};
    var params = {
        method: rule.method, control: rule.param.control,
        requirements: rule.requirements ? JSON.clone(rule.requirements) : undefined,
        url: safeDecodeURI(raw), rule: name, param: JSON.clone(rule.param), middleware: [], bundle: 'b'
    };
    var out = { past: false, threw: null };
    try {
        var found = await routing.compareUrls(params, rule.url, req, {}, function () {});
        out.past = !!(found && found.past);
    } catch (e) {
        out.threw = String((e && e.message) || e);
    }
    var p = Object.assign({}, req.params);
    delete p[0];
    out.params = p;
    out.bag    = req[method];
    out.param  = params.param;
    return out;
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

var FITS_DECL = "var fitsWithRequirements = async function(";
var T1_NEW    = "if (!_param || !_param.length) return false;";
var T1_OLD    = "if (!_param.length) return false;";
var T2_NEW    = "new RegExp(urlVar.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g')";
var T2_OLD    = "new RegExp(urlVar, 'g')";


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B1146 #B1148: the instrument and the controls', function () {

    it('01.1  the globals the harness needs are installed (safeDecodeURI, JSON.clone)', function () {
        assert.equal(typeof safeDecodeURI, 'function');
        assert.equal(typeof JSON.clone, 'function');
    });

    it('01.2  the plain /t/:id rule binds its segment (the known positive)', async function () {
        var r = await match('t_plain@b', '/t/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42' });
    });

    it('01.3  a request carrying the nameless segment as written matches it', async function () {
        var r = await match('t_lone@b', '/t/12:');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
    });

    it('01.4  a request whose path differs before the segment never reaches it', async function () {
        var r = await match('t_lone@b', '/u/12x');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, false);
    });

    it('01.5  a request carrying `:id)` as written matches /r/:id)', async function () {
        var r = await match('rx_paren@b', '/r/:id)');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
    });

    it('01.6  the plain /r/:id rule binds 42 (the known positive)', async function () {
        var r = await match('rx_plain@b', '/r/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42' });
    });
});


// ─── 02 — #B1146 ───────────────────────────────────────────────────────────────

describe('02 - #B1146: a `:` with no name after it', function () {

    it('02.1  a request that reaches the segment resolves without throwing, and does not match', async function () {
        var r = await match('t_lone@b', '/t/12x');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, false);
    });
});


// ─── 03 — #B1148 ───────────────────────────────────────────────────────────────

describe('03 - #B1148: a segment that is not a valid regular expression', function () {

    it('03.1  /r/:id) resolves without throwing; its placeholder takes the whole segment', async function () {
        var r = await match('rx_paren@b', '/r/42');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42' });
    });

    it('03.2  /r/[:id resolves without throwing; its placeholder takes the whole segment', async function () {
        var r = await match('rx_brack@b', '/r/42');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42' });
    });
});


// ─── 04 — the rewrites replace the segment's own text ─────────────────────────

describe('04 - #B1148: the title rewrite replaces the segment\'s own text', function () {

    it('04.1  control: a title holding the segment as written takes the URL value', async function () {
        var r = await match('feed_ctl@b', '/feedc/42.json');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.equal(r.param.title, 'Feed 42.json');
    });

    it('04.2  a `.` in the segment matches a dot, not any character', async function () {
        var r = await match('feed@b', '/feed/42.json');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.equal(r.param.title, 'Feed 42.json, not :idXjson');
    });
});


// ─── 05 — source pins ──────────────────────────────────────────────────────────

describe('05 - #B1146 #B1148: source', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('05.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.equal(count(live, FITS_DECL), 1, 'the strip must keep fitsWithRequirements');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });

    it('05.2  #B1146: a null name match returns false before its length is read', function () {
        assert.equal(count(live, T1_NEW), 1);
        assert.equal(count(live, T1_OLD), 0, 'the unguarded length read must not be live');
        assert.equal(count(raw, T1_OLD), 1, 'control: the old line is kept as a comment, which the strip removed');
    });

    it('05.3  #B1148: the segment is escaped before it is compiled', function () {
        assert.equal(count(live, T2_NEW), 1);
        assert.equal(count(live, T2_OLD), 0, 'the segment must not be compiled as written');
        assert.equal(count(raw, T2_OLD), 1, 'control: the old line is kept as a comment, which the strip removed');
    });
});


// ─── 06 — dist pin ─────────────────────────────────────────────────────────────

describe('06 - #B1146 #B1148: the browser bundle carries both lines', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('06.1  the unminified bundle carries lib/routing (control) and both lines', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, FITS_DECL), 1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, T1_NEW), 1, 'the rebuilt bundle must carry the #B1146 guard');
        assert.equal(count(dist, T2_NEW), 1, 'the rebuilt bundle must carry the #B1148 escape');
    });
});
