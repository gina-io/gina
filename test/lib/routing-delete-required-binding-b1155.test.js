'use strict';
/**
 * #B1155 — on a DELETE route with `requirements`, a placeholder with a regex requirement matches only when
 * the route binds it in `param`, as on GET.
 *
 * `parseRouting` matches such a rule in its own DELETE branch (not through `fitsWithRequirements`, the GET
 * path). Its regex arm tested a placeholder's requirement against the URL segment and scored it without
 * checking the binding: `/u/:grp/:id` with regex requirements on both and only `grp` bound answered a DELETE,
 * and the XHR GET the router serves as a DELETE, where its GET twin matches nothing, and the value reached
 * `req.delete` only. The arm now checks the binding first, as `fitsWithRequirements` does on GET and as the
 * branch does for a placeholder without a requirement (#B1144). A `validator::` requirement goes through
 * `fitsWithRequirements`, so it needed the binding before the fix as well.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers bootstrap (the
 * routing-params-delete-b955 shape), with the route description core/server.js builds. Seam:
 * `B1155_FW=<framework dir>` loads another tree's framework, for its pins AND its arms.
 *
 * Suites:
 *  01 — controls (hold before and after the fix)
 *  02 — the fix: such a route does not match (fix-sensitive)
 *  03 — source pin (comment-stripped, fix-sensitive)
 *  04 — dist pin: the unminified browser bundle carries the check (lib/routing is bundled)
 *
 * Red-first: run with `B1155_FW` pointing at the tree before this fix — suites 02, 03.1 and 04.1 red, the
 * others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B1155_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var REQ = { grp: '/^[a-z0-9]+$/', id: '/^[0-9]+$/' };
var TABLE = {
    // the defect's shape: regex requirements on both placeholders, only `grp` bound
    'del_unbound@b':       { method: 'DELETE', url: '/u/:grp/:id', requirements: REQ,
                             param: { control: 'rm', grp: ':grp' } },
    // its GET twin: matches nothing, before and after the fix
    'get_unbound@b':       { method: 'GET', url: '/gu/:grp/:id', requirements: REQ,
                             param: { control: 'show', grp: ':grp' } },
    // both placeholders bound (the known positives)
    'del_bound@b':         { method: 'DELETE', url: '/d/:grp/:id', requirements: REQ,
                             param: { control: 'rm', grp: ':grp', id: ':id' } },
    'get_bound@b':         { method: 'GET', url: '/gb/:grp/:id', requirements: REQ,
                             param: { control: 'show', grp: ':grp', id: ':id' } },
    // no requirement on `grp`, and `grp` unbound: no match since #B1144
    'del_free@b':          { method: 'DELETE', url: '/n/:grp/:id', requirements: { id: '/^[0-9]+$/' },
                             param: { control: 'rm', id: ':id' } },
    // a validator:: requirement on an unbound `id`: no match before the fix as well
    'del_val@b':           { method: 'DELETE', url: '/vu/:grp/:id',
                             requirements: { grp: '/^[a-z0-9]+$/', id: 'validator::{ isInteger: true }' },
                             param: { control: 'rm', grp: ':grp' } },
    // a culture prefix with a regex requirement, unbound (the i18n guide's case), then bound
    'del_culture@b':       { method: 'DELETE', url: '/:culture/items/:id',
                             requirements: { culture: '/^(en|fr)$/', id: '/^[0-9]+$/' },
                             param: { control: 'rm', id: ':id' }, culturePrefix: true },
    'del_culture_bound@b': { method: 'DELETE', url: '/:culture/things/:id',
                             requirements: { culture: '/^(en|fr)$/', id: '/^[0-9]+$/' },
                             param: { control: 'rm', culture: ':culture', id: ':id' }, culturePrefix: true }
};
Object.keys(TABLE).forEach(function (k) { TABLE[k].bundle = 'b'; });
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var commentStrip = require('../strip-comments');

/**
 * Match a raw request path against a rule the way core/server.js does: the route description carries the
 * rule's method as declared, the decoded path and a clone of `param`.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} reqMethod - the request's method
 * @param {string} raw - the request path
 * @param {boolean} [xhr] - the request is an XHR (the GET the router serves as a DELETE)
 * @returns {Promise<{past: boolean, params: object, bags: object}>} `params` is `req.params` minus its
 *   index-0 entry, `bags` the request's `get` and `delete` objects after the match
 */
async function match(name, reqMethod, raw, xhr) {
    var rule = TABLE[name];
    var req  = { url: raw, method: reqMethod, headers: {}, params: { 0: raw }, isXMLRequest: !!xhr };
    req[reqMethod.toLowerCase()] = {};
    var params = {
        method: rule.method, control: rule.param.control, requirements: JSON.clone(rule.requirements),
        url: (typeof(safeDecodeURI) == 'function') ? safeDecodeURI(raw) : raw, rule: name,
        culturePrefix: rule.culturePrefix || false, param: JSON.clone(rule.param), middleware: [], bundle: 'b',
        isXMLRequest: !!xhr
    };
    var out = await routing.compareUrls(params, rule.url, req, {}, function () {});
    var p = Object.assign({}, req.params);
    delete p[0];
    return { past: !!(out && out.past), params: p, bags: { get: req.get, delete: req.delete } };
}

/**
 * The source with its comments removed: block comments, and every full-line `//` comment blanked.
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
    return commentStrip.lines(s);
}

/**
 * A regular expression matching the literal tokens in order, with any whitespace between them.
 *
 * @inner
 * @param {string[]} tokens
 * @returns {RegExp}
 */
function seq(tokens) {
    return new RegExp(tokens.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('\\s*'), 'g');
}

/**
 * Count the matches of a global regular expression.
 *
 * @inner
 * @param {string} s
 * @param {RegExp} re
 * @returns {number}
 */
function countRe(s, re) {
    return (s.match(re) || []).length;
}

// The regex arm's condition with the binding check this fix adds before the expression is compiled.
var CHECK = seq([
    "&& typeof(condition) != 'undefined'",
    '&& hasOwn(params.param, _key)',
    "&& typeof(params.param[_key]) != 'undefined'",
    '&& new RegExp(condition, conditionFlags).test(uRe[p])'
]);
// The regex arm's own test, live before and after the fix.
var ARM = '&& new RegExp(condition, conditionFlags).test(uRe[p])';


// ─── 01 — controls ─────────────────────────────────────────────────────────────

describe('01 - #B1155: controls (hold before and after the fix)', function () {

    it('01.1  DELETE, both placeholders bound: the route matches and req.params carries both', async function () {
        var r = await match('del_bound@b', 'DELETE', '/d/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('01.2  the GET twin of the unbound shape matches nothing', async function () {
        assert.equal((await match('get_unbound@b', 'GET', '/gu/g1/42')).past, false);
    });

    it('01.3  GET, both placeholders bound: the route matches and req.params carries both', async function () {
        var r = await match('get_bound@b', 'GET', '/gb/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('01.4  DELETE, a placeholder without a requirement and unbound: no match (#B1144)', async function () {
        assert.equal((await match('del_free@b', 'DELETE', '/n/g1/42')).past, false);
    });

    it('01.5  DELETE, a validator:: requirement on an unbound placeholder: no match', async function () {
        assert.equal((await match('del_val@b', 'DELETE', '/vu/g1/42')).past, false);
    });

    it('01.6  a value its requirement rejects: no match', async function () {
        assert.equal((await match('del_unbound@b', 'DELETE', '/u/g1/abc')).past, false);
    });

    it('01.7  a culture prefix with a regex requirement, bound: the route matches and req.params.culture is set', async function () {
        var r = await match('del_culture_bound@b', 'DELETE', '/fr/things/42');
        assert.equal(r.past, true);
        assert.equal(r.params.culture, 'fr');
    });

    it('01.8  the XHR GET the router serves as a DELETE reaches a route whose placeholders are bound', async function () {
        var r = await match('del_bound@b', 'GET', '/d/g1/42', true);
        assert.equal(r.past, true);
        assert.deepEqual(r.bags.delete, { grp: 'g1', id: '42' });
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B1155: a regex requirement on an unbound placeholder does not make a DELETE route match', function () {

    it('02.1  DELETE /u/g1/42 (regex requirements on both, only grp bound): no match, as on GET', async function () {
        assert.equal((await match('del_unbound@b', 'DELETE', '/u/g1/42')).past, false);
    });

    it('02.2  the unbound placeholder\'s value is not written to req.delete', async function () {
        var r = await match('del_unbound@b', 'DELETE', '/u/g1/42');
        assert.equal(r.bags.delete.id, undefined);
    });

    it('02.3  the XHR GET the router serves as a DELETE does not match that route either', async function () {
        assert.equal((await match('del_unbound@b', 'GET', '/u/g1/42', true)).past, false);
    });

    it('02.4  a culture prefix with a regex requirement, unbound: no match', async function () {
        assert.equal((await match('del_culture@b', 'DELETE', '/fr/items/42')).past, false);
    });
});


// ─── 03 — source pin ───────────────────────────────────────────────────────────

describe('03 - #B1155: source — the regex arm checks the binding before it compiles the requirement', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('03.1  the regex arm carries the binding check, once, right before its test', function () {
        assert.equal(countRe(live, CHECK), 1);
    });

    it('03.2  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.equal(live.split(ARM).length - 1, 1, 'the regex arm\'s test must be live, exactly once');
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });
});


// ─── 04 — dist pin ─────────────────────────────────────────────────────────────

describe('04 - #B1155: the browser bundle carries the check', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries the binding check', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(countRe(dist, CHECK), 1, 'the rebuilt bundle must carry the binding check');
    });

    it('04.2  control: the unminified bundle carries the regex arm (lib/routing is bundled)', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(dist.split(ARM).length - 1, 1);
    });
});
