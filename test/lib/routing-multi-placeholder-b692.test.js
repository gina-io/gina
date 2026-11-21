'use strict';
/**
 * #B692 — a URL segment holding two or more placeholders (`/shop/item-:sku-:lang`) never matches a
 * value, and never makes the route matcher throw.
 *
 * `fitsWithRequirements` (lib/routing) sent such a segment to a « slow » path that took
 * `params.url`, the request path, as its template and compared the request with itself: the segment
 * matched only its own literal text, and on a route with `requirements` a request carrying a
 * decodable %-escape (`/shop/item-1%202-fr`, `/sh%6Fp/item-12-fr`) read `key[0]` on a null `key` and
 * threw, a 500 naming the rule, and no later rule was tried. The slow path now returns false. The
 * DELETE branch of `parseRouting`, which matches a DELETE route that declares `requirements`, now
 * skips such a segment too: there it scored, so `DELETE /range/1-5` reached a `/range/:from-:to`
 * route. A request still matches such a segment by carrying its text as written; a boot warning
 * lists such segments (config-placeholder-multi-b692.test.js).
 *
 * Strategy: the REAL lib/routing (`compareUrls`) through the framework's helpers bootstrap, driven as
 * core/server.js drives it: the raw path in `req.url`, its `safeDecodeURI` form in `params.url` (the
 * pair the %-escape defect needs). Seam: `B692_FW=<framework dir>` loads another tree's framework,
 * for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — a decodable %-escape no longer throws (fix-sensitive)
 *  03 — source pins: the slow path returns false first, and the DELETE branch skips such a segment
 *       (comment-stripped, fix-sensitive)
 *  04 — dist pins (lib/routing is bundled)
 *  05 — on a DELETE route with `requirements`, such a segment matches only as written
 *       (05.3 and 05.4 fix-sensitive)
 *
 * Red-first: run with `B692_FW` pointing at the tree before this fix — suites 02, 03.2, 03.3, 04,
 * 05.3 and 05.4 red, the others green. Suite 04 stays red on a fixed source until the browser bundle
 * is rebuilt.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B692_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var SKULANG = { sku: '/^[0-9]+$/', lang: '/^[a-z]{2}$/' };
var TABLE = {
    // the defect's shape: two placeholders in one segment, with requirements
    'two_req@b':   { method: 'GET', url: '/shop/item-:sku-:lang', bundle: 'b', requirements: SKULANG, param: { control: 'sku', sku: ':sku', lang: ':lang' } },
    // the same without requirements (it never reached the throw)
    'two_noreq@b': { method: 'GET', url: '/shop/item-:sku-:lang', bundle: 'b', param: { control: 'sku', sku: ':sku', lang: ':lang' } },
    // one placeholder per segment (the known positive)
    'seg@b':       { method: 'GET', url: '/shop/:sku/:lang', bundle: 'b', requirements: SKULANG, param: { control: 'sku', sku: ':sku', lang: ':lang' } },
    // DELETE with requirements: one placeholder per segment (the known positive), then the defect's
    // shape with its first name bound and required (a requirement the whole value meets), and bound
    // with no requirement of its own (another placeholder carries the route's requirement)
    'del_seg@b':   { method: 'DELETE', url: '/range/:from/:to', bundle: 'b', requirements: { from: '/^[0-9]+$/', to: '/^[0-9]+$/' }, param: { control: 'rm', from: ':from', to: ':to' } },
    'del_two@b':   { method: 'DELETE', url: '/range/:from-:to', bundle: 'b', requirements: { from: '/^[0-9-]+$/' }, param: { control: 'rm', from: ':from', to: ':to' } },
    'del_bound@b': { method: 'DELETE', url: '/span/:from-:to/:id', bundle: 'b', requirements: { id: '/^[0-9]+$/' }, param: { control: 'rm', from: ':from', id: ':id' } }
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

var FITS_DECL  = "var fitsWithRequirements = async function(";
var SLOW_HEAD  = "} else { // slow one";
var OLD_CODE   = "var keys        = _param";
var DEL_EQ     = "if (uRe[p] === uRo[p]) {";
var DEL_SKIP   = "if ( (uRo[p].match(/\\:\\w+/g) || []).length > 1 ) {";


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B692: the instrument and the controls', function () {

    it('01.1  one placeholder per segment binds both values (the known positive)', async function () {
        var r = await match('seg@b', '/shop/12/fr');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { sku: '12', lang: 'fr' });
    });

    it('01.2  a two-placeholder segment does not match a plain request', async function () {
        var r = await match('two_req@b', '/shop/item-12-fr');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, false);
    });

    it('01.3  without requirements, a %-escape neither matches nor throws', async function () {
        var r = await match('two_noreq@b', '/shop/item-1%202-fr');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, false);
    });

    it('01.4  a request carrying the segment as written matches it', async function () {
        var r = await match('two_req@b', '/shop/item-:sku-:lang');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B692: a decodable %-escape no longer makes the matcher throw', function () {

    it('02.1  an escape inside the segment: resolves without throwing, does not match', async function () {
        var r = await match('two_req@b', '/shop/item-1%202-fr');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, false);
    });

    it('02.2  an escape before the segment: resolves without throwing, does not match', async function () {
        var r = await match('two_req@b', '/sh%6Fp/item-12-fr');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, false);
    });
});


// ─── 03 — source pin ───────────────────────────────────────────────────────────

describe('03 - #B692: source — the slow path returns false first', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('03.1  control: the strip keeps live code and the slow path\'s head', function () {
        assert.equal(count(live, FITS_DECL), 1);
        assert.equal(count(live, SLOW_HEAD), 1, 'the slow path\'s head must be live, once');
    });

    it('03.2  `return false;` is the slow path\'s first live statement, and its old body is not live', function () {
        assert.equal(countRe(live, seq([SLOW_HEAD, 'return false;'])), 1);
        assert.equal(count(live, OLD_CODE), 0, 'the old slow path must not be live');
        assert.equal(count(raw, OLD_CODE), 1, 'control: the old body is kept as a comment, which the strip removed');
    });

    it('03.3  the DELETE branch skips such a segment right after its equality check', function () {
        assert.equal(count(live, DEL_EQ), 1, 'control: the DELETE branch\'s equality check must be live, once');
        assert.equal(count(live, DEL_SKIP), 1, 'the skip must be live, once');
        assert.equal(countRe(live, seq([DEL_EQ, '++score;', 'continue;', '}', DEL_SKIP, 'continue;', '}'])), 1);
    });
});


// ─── 04 — dist pin ─────────────────────────────────────────────────────────────

describe('04 - #B692: the browser bundle carries the early return', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('04.1  the unminified bundle carries lib/routing (control) and the early return', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, SLOW_HEAD), 1, 'control: the slow path must be in the bundle');
        assert.equal(countRe(dist, seq([SLOW_HEAD, 'return false;'])), 1, 'the rebuilt bundle must carry the early return');
    });

    it('04.2  the unminified bundle carries the DELETE branch (control) and its skip', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, DEL_EQ), 1, 'control: the DELETE branch must be in the bundle');
        assert.equal(countRe(dist, seq([DEL_EQ, '++score;', 'continue;', '}', DEL_SKIP, 'continue;', '}'])), 1, 'the rebuilt bundle must carry the skip');
    });
});


// ─── 05 — a DELETE route with requirements ─────────────────────────────────────

describe('05 - #B692: on a DELETE route with `requirements`, such a segment matches only as written', function () {

    it('05.1  one placeholder per segment binds both values (the known positive)', async function () {
        var r = await match('del_seg@b', '/range/1/5');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { from: '1', to: '5' });
    });

    it('05.2  a request carrying the segment as written matches it', async function () {
        var r = await match('del_two@b', '/range/:from-:to');
        assert.equal(r.threw, null, r.threw);
        assert.equal(r.past, true);
    });

    it('05.3  a value its first name\'s requirement accepts does not match, and nothing is written for it', async function () {
        var r = await match('del_two@b', '/range/1-5');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, false);
        assert.equal(Object.prototype.hasOwnProperty.call(r.bag, 'from'), false, JSON.stringify(r.bag));
        assert.equal(Object.prototype.hasOwnProperty.call(r.bag, 'from-:to'), false, JSON.stringify(r.bag));
    });

    it('05.4  bound with no requirement of its own, it does not match either', async function () {
        var r = await match('del_bound@b', '/span/1-5/7');
        assert.equal(r.threw, null, 'the matcher threw: ' + r.threw);
        assert.equal(r.past, false);
    });
});
