'use strict';
/**
 * #B1153 — the routing block that runs a `validator::` requirement the route does not bind in
 * `param` reads placeholder names in any letter case.
 *
 * That block (lib/routing `parseRouting`) listed the URL's placeholder names with
 * `/\:[-_a-z0-9]+/g`, a class with no capital. `:userId` was read as `:user`, so a validator's
 * `query.data` entry referencing `":userId"` was dropped before the validator ran, and a URL whose
 * names all hold capitals (`/u/:ID`) gave null, whose `indexOf` threw: a 500 naming the rule. Names
 * are now read with `/\:\w+/g`, as the rest of the router reads them, and the per-segment name by the
 * same grammar.
 *
 * #B1148, here for this file's seam: when a placeholder has a `validator::` requirement,
 * `fitsWithRequirements` compiles the segment's other characters into a pattern (`:)` for `:id)`,
 * `[:` for `[:id`). It compiled them unescaped, so a segment that is not a valid regular expression
 * threw « Invalid regular expression »: a 500 naming the rule. They are now escaped.
 *
 * Strategy: the REAL lib/routing, with core/plugins' `Validator` replaced by a recorder BEFORE
 * lib/routing loads (lib/routing reads `plugins.Validator` once, at load), so this file needs its
 * own process (node --test runs each file in one). The recorder answers every query valid, and its
 * `isValid()` true (the validator branch of `fitsWithRequirements` reads it). Seam:
 * `B1153_FW=<framework dir>` loads another tree's framework, for its pins AND its arms.
 *
 * Suites:
 *  01 — the seam and the controls (hold before and after the fix)
 *  02 — a camel-case name keeps its `query.data` entry (fix-sensitive)
 *  03 — an all-capital name no longer throws (fix-sensitive)
 *  04 — source pins (comment-stripped, fix-sensitive)
 *  05 — dist pin (lib/routing is bundled)
 *  06 — #B1148: a `validator::` requirement on a segment that is not a valid regular expression
 *       (fix-sensitive)
 *
 * Red-first: run with `B1153_FW` pointing at the tree before this fix — suites 02, 03, 04.2, 04.3, 05
 * and 06 red, the others green. Suites 05 and 06.4 stay red on a fixed source until the browser
 * bundle is rebuilt.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B1153_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    'v_camel@b': { method: 'GET', url: '/u/:userId', bundle: 'b', requirements: { check: 'validator::{ query: { data: { id: ":userId" } } }' }, param: { control: 'u', userId: ':userId' } },
    'v_upper@b': { method: 'GET', url: '/u/:ID', bundle: 'b', requirements: { check: 'validator::{ query: { data: { id: ":ID" } } }' }, param: { control: 'u', ID: ':ID' } },
    'v_lower@b': { method: 'GET', url: '/u/:userid', bundle: 'b', requirements: { check: 'validator::{ query: { data: { id: ":userid" } } }' }, param: { control: 'u', userid: ':userid' } },
    'v_same@b':  { method: 'GET', url: '/u/:userId', bundle: 'b', requirements: { check: 'validator::{ query: { data: { userId: ":userId" } } }' }, param: { control: 'u', userId: ':userId' } },
    // #B1148: a bound placeholder with a `validator::` requirement, in a segment that is not a valid regular expression
    'v_paren@b':   { method: 'GET', url: '/r/:id)', bundle: 'b', requirements: { id: 'validator::{ query: { data: { id: ":id" } } }' }, param: { control: 'r', id: ':id' } },
    'v_bracket@b': { method: 'GET', url: '/r2/[:id', bundle: 'b', requirements: { id: 'validator::{ query: { data: { id: ":id" } } }' }, param: { control: 'r', id: ':id' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });

// The seam: a recording Validator, set before lib/routing reads it.
var ROUTING_MAIN      = require.resolve(path.join(FW, 'lib/routing'));
var LOADED_EARLY      = !!require.cache[ROUTING_MAIN];
var plugins           = require(path.join(FW, 'core/plugins'));
var LOADED_BY_PLUGINS = !!require.cache[ROUTING_MAIN];
var RECORDS = [];
plugins.Validator = function RecordingValidator(type, data, unused, rule) {
    RECORDS.push({ type: type, data: JSON.parse(JSON.stringify(data)) });
    var self = this;
    Object.keys(rule || {}).forEach(function (k) {
        self[k] = { query: async function () { return { isValid: true }; } };
    });
    self.isValid = function () { return true; };
};
var routing = require(path.join(FW, 'lib/routing'));

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

var FITS_DECL = "var fitsWithRequirements = async function(";
var NEW_VARS  = "uRo.join(',').match(/\\:\\w+/g) || []";
var OLD_VARS  = "uRo.join(',').match(/\\:[-_a-z0-9]+/g)";
var NEW_PNAME = "let pName = ( uRo[p].match(/^\\:(\\w+)/) || [] )[1] || '';";
var OLD_PNAME = "let pName = uRo[p].replace(/^\\:/, '');";
var ESC_NEW   = "new RegExp(str.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g')";
var ESC_OLD   = "_data[key]  = urlVal.replace( new RegExp(str, 'g'), '');";

/**
 * Match `raw` against `name` and return the reading with the data the recorder received.
 *
 * @inner
 * @param {string} name
 * @param {string} raw
 * @returns {Promise<object>} the match() reading plus `records`, the validator data of this match
 */
async function drive(name, raw) {
    var n0 = RECORDS.length;
    var r  = await match(name, raw);
    r.records = RECORDS.slice(n0).map(function (x) { return x.data; });
    return r;
}


// ─── 01 — the seam and the controls ───────────────────────────────────────────

describe('01 - #B1153: the seam and the controls', function () {

    it('01.1  the recorder was set before lib/routing loaded', function () {
        assert.equal(LOADED_EARLY, false, 'lib/routing was loaded before the seam');
        assert.equal(LOADED_BY_PLUGINS, false, 'core/plugins loaded lib/routing before the seam could be set');
    });

    it('01.2  a lower-case name keeps its query.data entry (the known positive)', async function () {
        var r = await drive('v_lower@b', '/u/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.records.length, 1, 'the validator must run once');
        assert.ok(Object.prototype.hasOwnProperty.call(r.records[0], 'id'), JSON.stringify(r.records[0]));
        assert.equal(r.records[0].userid, '42');
    });

    it('01.3  an entry named after the placeholder carries the URL value', async function () {
        var r = await drive('v_same@b', '/u/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].userId, '42');
    });
});


// ─── 02 — a camel-case name ────────────────────────────────────────────────────

describe('02 - #B1153: a camel-case name keeps its query.data entry', function () {

    it('02.1  /u/:userId keeps the `id` entry that references it, as a lower-case name does', async function () {
        var r = await drive('v_camel@b', '/u/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.records.length, 1);
        assert.ok(Object.prototype.hasOwnProperty.call(r.records[0], 'id'), 'the id entry was dropped: ' + JSON.stringify(r.records[0]));
        assert.equal(r.records[0].userId, '42');
    });
});


// ─── 03 — an all-capital name ──────────────────────────────────────────────────

describe('03 - #B1153: an all-capital name no longer throws', function () {

    it('03.1  /u/:ID resolves without throwing and matches (the recorder answers valid)', async function () {
        var r = await drive('v_upper@b', '/u/42');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, true);
        assert.equal(r.records.length, 1);
        assert.ok(Object.prototype.hasOwnProperty.call(r.records[0], 'id'), JSON.stringify(r.records[0]));
        assert.equal(r.records[0].ID, '42');
    });
});


// ─── 04 — source pins ──────────────────────────────────────────────────────────

describe('04 - #B1153: source', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code', function () {
        assert.equal(count(live, FITS_DECL), 1);
    });

    it('04.2  both name reads use the router\'s grammar, with an empty list when there is none', function () {
        assert.equal(count(live, NEW_VARS), 2);
        assert.equal(count(live, OLD_VARS), 0, 'the class without capitals must not be live');
        assert.equal(count(raw, OLD_VARS), 2, 'control: the old lines are kept as comments, which the strip removed');
    });

    it('04.3  the per-segment name uses the same grammar', function () {
        assert.equal(count(live, NEW_PNAME), 1);
        assert.equal(count(live, OLD_PNAME), 0);
    });
});


// ─── 05 — dist pin ─────────────────────────────────────────────────────────────

describe('05 - #B1153: the browser bundle carries both reads', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/routing (control) and the new reads', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, FITS_DECL), 1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, NEW_VARS), 2, 'the rebuilt bundle must carry both reads');
        assert.equal(count(dist, NEW_PNAME), 1);
    });
});


// ─── 06 — #B1148 in the validator branch ───────────────────────────────────────

describe('06 - #B1148: a `validator::` requirement on a segment that is not a valid regular expression', function () {

    it('06.1  /r/:id): resolves without throwing, the validator runs once on the value, and the route matches', async function () {
        var r = await drive('v_paren@b', '/r/42');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, true);
        assert.equal(r.records.length, 1, 'the validator must run once');
        assert.deepEqual(r.records[0], { id: '42' });
        assert.equal(r.params.id, '42');
    });

    it('06.2  /r2/[:id: resolves without throwing, the validator runs once on the value, and the route matches', async function () {
        var r = await drive('v_bracket@b', '/r2/42');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, true);
        assert.equal(r.records.length, 1, 'the validator must run once');
        assert.deepEqual(r.records[0], { id: '42' });
        assert.equal(r.params.id, '42');
    });

    it('06.3  source: the segment\'s other characters are escaped before they are compiled', function () {
        var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
        var live = stripComments(raw);
        assert.equal(count(live, ESC_NEW), 1);
        assert.equal(count(live, ESC_OLD), 0, 'the unescaped pattern must not be live');
        assert.equal(count(raw, ESC_OLD), 1, 'control: the old line is kept as a comment, which the strip removed');
    });

    it('06.4  dist: the unminified bundle carries lib/routing (control) and the escape', function () {
        var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, FITS_DECL), 1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, ESC_NEW), 1, 'the rebuilt bundle must carry the escape');
    });
});
