'use strict';
/**
 * #B1149 + #B1144 — on a DELETE route with `requirements`, a placeholder is read as on every other
 * route.
 *
 * `parseRouting` (lib/routing) matches a DELETE route that declares `requirements` in a branch of its
 * own. #B1149: that branch keyed a placeholder by the whole rest of its segment, so `/feed/:id.json`
 * bound `id.json`, a requirement on `id` was never applied, and the route matched any segment. The
 * key is now the placeholder's name (letters, digits and underscores, as `fitsWithRequirements` reads
 * it on GET), and its value is still the whole segment. #B1144: a placeholder with no requirement
 * scored there whether or not the route bound it in `param`, so a DELETE route answered where its GET
 * twin matches nothing; it now scores only when the route binds it, as on GET. A segment with text
 * before its placeholder (`page:number`) is still compared as written.
 *
 * Strategy: the REAL lib/routing (`compareUrls`) through the framework's helpers bootstrap. Seam:
 * `B1149_FW=<framework dir>` loads another tree's framework, for its pins AND its arms.
 *
 * Suites:
 *  01 — the controls (hold before and after the fix)
 *  02 — #B1149: the key is the placeholder's name (fix-sensitive)
 *  03 — #B1144: an unbound placeholder without a requirement does not score (fix-sensitive)
 *  04 — source pins (comment-stripped, fix-sensitive)
 *  05 — dist pin (lib/routing is bundled)
 *
 * Red-first: run with `B1149_FW` pointing at the tree before this fix — suites 02, 03, 04.2, 04.3 and
 * 05 red, the others green. Suite 05 stays red on a fixed source until the browser bundle is rebuilt.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B1149_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var NUM     = { id: '/^[0-9]+$/' };
var WHOLE   = { id: '/^[0-9]+\\.json$/' };
var TABLE = {
    // #B1149: text after the name; a requirement on `id` that the whole segment fails, and one it meets
    'del_suffix@b':  { method: 'DELETE', url: '/feed/:id.json', bundle: 'b', requirements: NUM, param: { control: 'rm', id: ':id' } },
    'del_whole@b':   { method: 'DELETE', url: '/whole/:id.json', bundle: 'b', requirements: WHOLE, param: { control: 'rm', id: ':id' } },
    'get_whole@b':   { method: 'GET', url: '/gwhole/:id.json', bundle: 'b', requirements: WHOLE, param: { control: 'show', id: ':id' } },
    'del_plain@b':   { method: 'DELETE', url: '/feed2/:id', bundle: 'b', requirements: NUM, param: { control: 'rm', id: ':id' } },
    // #B1144: a placeholder with no requirement that the route does not bind, on DELETE and on GET
    'del_unbound@b': { method: 'DELETE', url: '/n/:grp/:id', bundle: 'b', requirements: NUM, param: { control: 'rm', id: ':id' } },
    'get_unbound@b': { method: 'GET', url: '/gn/:grp/:id', bundle: 'b', requirements: NUM, param: { control: 'show', id: ':id' } },
    'del_bound@b':   { method: 'DELETE', url: '/m/:grp/:id', bundle: 'b', requirements: NUM, param: { control: 'rm', grp: ':grp', id: ':id' } },
    // unchanged: text before a placeholder is compared as written on DELETE
    'del_prefix@b':  { method: 'DELETE', url: '/articles/page:number', bundle: 'b', requirements: { number: '/^[0-9]+$/' }, param: { control: 'rm', number: ':number' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
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
var KEY_LINE  = "let _key = /^:\\w/.test(uRo[p]) ? uRo[p].match(/^:(\\w+)/)[1] : uRo[p].substring(1);";
var OLD_WRITE = "request[method][uRo[p].substring(1)] = uRe[p];";
var IF_LINE   = "if ( /^:/.test(uRo[p]) && uRe[p] ) {";
var GUARD     = "if ( !hasOwn(params.param, _key) || typeof(params.param[_key]) == 'undefined' ) {";

/**
 * Assert that `raw` does not match the rule `name` and that the matcher did not throw: `match()`
 * reads a throw as `past: false`, so an assertion on `past` alone passes on a throwing matcher.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} raw - the raw request path
 * @param {string} [msg] - the message of the `past` assertion
 * @returns {Promise<object>} the match() reading
 */
async function noMatch(name, raw, msg) {
    var r = await match(name, raw);
    assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
    assert.equal(r.past, false, msg);
    return r;
}


// ─── 01 — the controls ─────────────────────────────────────────────────────────

describe('01 - #B1149 #B1144: the controls', function () {

    it('01.1  DELETE /feed2/:id binds 42 and refuses abc', async function () {
        var r = await match('del_plain@b', '/feed2/42');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { id: '42' });
        assert.deepEqual(r.params, { id: '42' });
        await noMatch('del_plain@b', '/feed2/abc');
    });

    it('01.2  GET /gwhole/:id.json binds the whole segment to `id`', async function () {
        var r = await match('get_whole@b', '/gwhole/42.json');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42.json' });
    });

    it('01.3  GET with an unbound placeholder without a requirement matches nothing', async function () {
        await noMatch('get_unbound@b', '/gn/g1/42');
    });

    it('01.4  DELETE with both placeholders bound matches', async function () {
        var r = await match('del_bound@b', '/m/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });

    it('01.5  DELETE compares a segment with text before its placeholder as written', async function () {
        await noMatch('del_prefix@b', '/articles/page3');
        assert.equal((await match('del_prefix@b', '/articles/page:number')).past, true);
    });
});


// ─── 02 — #B1149 ───────────────────────────────────────────────────────────────

describe('02 - #B1149: the key is the placeholder\'s name, the value the whole segment', function () {

    it('02.1  the requirement on `id` is applied: /feed/:id.json refuses 42.json, abc.json and abc', async function () {
        await noMatch('del_suffix@b', '/feed/42.json', '42.json fails /^[0-9]+$/');
        await noMatch('del_suffix@b', '/feed/abc.json');
        await noMatch('del_suffix@b', '/feed/abc');
    });

    it('02.2  a requirement the whole segment meets binds `id`, in req.delete and req.params', async function () {
        var r = await match('del_whole@b', '/whole/42.json');
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { id: '42.json' });
        assert.deepEqual(r.params, { id: '42.json' });
    });

    it('02.3  a segment that requirement refuses does not match', async function () {
        await noMatch('del_whole@b', '/whole/abc.json');
    });
});


// ─── 03 — #B1144 ───────────────────────────────────────────────────────────────

describe('03 - #B1144: an unbound placeholder without a requirement does not score', function () {

    it('03.1  the DELETE route does not match, as its GET twin does not', async function () {
        await noMatch('del_unbound@b', '/n/g1/42');
    });

    it('03.2  the unbound placeholder is not written to req.delete', async function () {
        var r = await noMatch('del_unbound@b', '/n/g1/42');
        assert.equal(Object.prototype.hasOwnProperty.call(r.bag, 'grp'), false, JSON.stringify(r.bag));
    });
});


// ─── 04 — source pins ──────────────────────────────────────────────────────────

describe('04 - #B1149 #B1144: source', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code and the DELETE branch\'s block', function () {
        assert.equal(count(live, FITS_DECL), 1);
        assert.equal(count(live, IF_LINE), 1);
    });

    it('04.2  #B1149: the key is the name, and no write is keyed by the whole segment', function () {
        assert.equal(count(live, KEY_LINE), 1);
        assert.equal(count(live, OLD_WRITE), 0);
        assert.equal(count(raw, OLD_WRITE), 1, 'control: the old write is kept as a comment, which the strip removed');
    });

    it('04.3  #B1144: inside the block, an unbound placeholder continues before it scores', function () {
        assert.equal(countRe(live, seq([IF_LINE, GUARD, 'continue;', '}', '++score;'])), 1);
    });
});


// ─── 05 — dist pin ─────────────────────────────────────────────────────────────

describe('05 - #B1149 #B1144: the browser bundle carries both changes', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/routing (control), the key and the guard', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, IF_LINE), 1, 'control: the DELETE branch must be in the bundle');
        assert.equal(count(dist, KEY_LINE), 1);
        assert.equal(countRe(dist, seq([IF_LINE, GUARD, 'continue;', '}', '++score;'])), 1);
    });
});
