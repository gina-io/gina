'use strict';
/**
 * #B956 — a DELETE route whose `requirements` cover only some of its URL placeholders matches.
 *
 * `parseRouting` matches a DELETE rule that declares `requirements` in its own DELETE branch: each
 * placeholder's regex is tested against its URL segment and scores. A placeholder the rule declared
 * NO requirement for was skipped without scoring, so such a rule never reached `maxLen` and answered
 * 404 on every request — while the same rule on GET (matched by `fitsWithRequirements`, which accepts
 * any non-empty segment for a placeholder without a requirement) matched. The branch now scores that
 * placeholder on a non-empty segment, writing `request[method]` and, for a placeholder bound in
 * `param`, `request.params` (the #B955 gate). A static segment that differs from the URL's is still
 * skipped unscored, so a rule whose fixed segment does not match still answers 404.
 *
 * Not pinned here: which value wins in `req.delete` when the client sends a same-name query key
 * (#B954); the arms send one only to show `req.params` ignores it.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers bootstrap
 * (the routing-params-delete-b955 shape) — no replica to drift. Seam: `B956_FW=<framework dir>`
 * loads another tree's framework (for example the tree before this fix), for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — the fix: the partly covered DELETE rule matches, with the bags set (fix-sensitive)
 *  03 — the unbound placeholder: in `req.delete`, out of `req.params` (fix-sensitive)
 *  04 — source pin (comment-stripped, fix-sensitive)
 *  05 — dist pin: the unminified browser bundle carries the block (lib/routing is bundled)
 *
 * Red-first: run with `B956_FW` pointing at the tree before this fix — suites 02, 03, 04.2 and 05
 * red, the others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B956_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var ID_ONLY = { id: '/^[0-9]+$/' };
var BOTH    = { grp: '/^[a-z0-9]+$/', id: '/^[0-9]+$/' };
var TABLE = {
    // the defect's shape: DELETE, a requirement on `id` only, both placeholders bound in param
    'delmixed@b':   { method: 'DELETE', url: '/m/:grp/:id', bundle: 'b', requirements: ID_ONLY,
                      param: { control: 'rm', grp: ':grp', id: ':id' } },
    // the same shape with `grp` not bound in param: it still matches, `grp` stays out of req.params
    'delunbound@b': { method: 'DELETE', url: '/n/:grp/:id', bundle: 'b', requirements: ID_ONLY,
                      param: { control: 'rm', id: ':id' } },
    // the same shape on GET (the known positive, matched by fitsWithRequirements)
    'getmixed@b':   { method: 'GET', url: '/g/:grp/:id', bundle: 'b', requirements: ID_ONLY,
                      param: { control: 'show', grp: ':grp', id: ':id' } },
    // a DELETE rule whose requirements cover both placeholders (the known positive, unchanged)
    'delboth@b':    { method: 'DELETE', url: '/d/:grp/:id', bundle: 'b', requirements: BOTH,
                      param: { control: 'rm', grp: ':grp', id: ':id' } },
    // a fixed segment beside a required placeholder: the fixed segment must still match literally
    'delstatic@b':  { method: 'DELETE', url: '/s/fixed/:id', bundle: 'b', requirements: ID_ONLY,
                      param: { control: 'rm', id: ':id' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));

/**
 * Match `url` against a rule the way the engine does (server.js builds this route description), with
 * `data` as the request's query data for the rule's method.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} url - the request path
 * @param {object} [data] - the request's query data (copied)
 * @returns {Promise<{past: boolean, params: object, bag: object}>} `params` is `req.params` minus its
 *   index-0 entry, `bag` the method's data bag after the match
 */
async function match(name, url, data) {
    var rule   = TABLE[name];
    var method = rule.method.toLowerCase();
    var req    = { url: url, method: rule.method, headers: {}, params: { 0: url } };
    req[method] = Object.assign({}, data || {});
    var params = {
        method: rule.method, control: rule.param.control, requirements: rule.requirements, url: url,
        rule: name, param: JSON.clone(rule.param), middleware: [], bundle: 'b'
    };
    var out = await routing.compareUrls(params, rule.url, req, {}, function () {});
    var p = Object.assign({}, req.params);
    delete p[0];
    return { past: !!(out && out.past), params: p, bag: req[method] };
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

// The branch's own-requirement gate (#B650), the block this fix adds inside it, and its `continue`.
var GATE  = 'if ( !hasOwn(params.requirements, _key) || typeof(params.requirements[_key]) == \'undefined\' ) {';
var BLOCK = 'if ( /^:/.test(uRo[p]) && uRe[p] ) {\n'
          + '                            ++score;\n'
          + '                            request[method][_key] = uRe[p];';


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B956: the instrument and the controls', function () {

    it('01.1  the same shape on GET matches, with both placeholders in req.params (the known positive)', async function () {
        var r = await match('getmixed@b', '/g/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('01.2  a DELETE rule whose requirements cover both placeholders matches (unchanged)', async function () {
        var r = await match('delboth@b', '/d/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });

    it('01.3  a value its requirement rejects skips the partly covered DELETE rule (the known negative)', async function () {
        assert.equal((await match('delmixed@b', '/m/g1/notanumber')).past, false);
    });

    it('01.4  a fixed segment that differs from the URL still skips the rule (the known negative)', async function () {
        assert.equal((await match('delstatic@b', '/s/other/42')).past, false);
        assert.equal((await match('delstatic@b', '/s/fixed/42')).past, true, 'control: the fixed segment matches literally');
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B956: a DELETE rule whose requirements cover only some of its placeholders matches', function () {

    it('02.1  the rule matches on a URL its requirement accepts', async function () {
        var r = await match('delmixed@b', '/m/g1/42');
        assert.equal(r.past, true, 'the route must match: the placeholder without a requirement accepts the segment');
    });

    it('02.2  both placeholders reach req.params and req.delete with the URL values', async function () {
        var r = await match('delmixed@b', '/m/g1/42');
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });

    it('02.3  a same-name query key does not change req.params', async function () {
        var r = await match('delmixed@b', '/m/g1/42', { grp: 'zz', x: '1' });
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('02.4  an empty segment for the placeholder without a requirement does not match', async function () {
        assert.equal((await match('delmixed@b', '/m//42')).past, false);
    });
});


// ─── 03 — the unbound placeholder ─────────────────────────────────────────────

describe('03 - #B956: a placeholder the rule does not bind in param stays out of req.params', function () {

    it('03.1  the rule matches; the bound placeholder reaches req.params, the unbound one does not', async function () {
        var r = await match('delunbound@b', '/n/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { id: '42' });
    });

    it('03.2  req.delete carries both', async function () {
        var r = await match('delunbound@b', '/n/g1/42');
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });
});


// ─── 04 — source pin ───────────────────────────────────────────────────────────

describe('04 - #B956: source — the branch scores a placeholder without a requirement before its continue', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.equal(count(live, GATE), 1, 'the own-requirement gate must be live, exactly once');
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });

    it('04.2  the block sits inside the gate, once, before its continue', function () {
        assert.equal(count(live, BLOCK), 1);
        var gate = live.indexOf(GATE), block = live.indexOf(BLOCK);
        assert.ok(block > gate && block - gate < 200, 'the block must open right after the gate (' + (block - gate) + ' chars)');
        var cont = live.indexOf('continue;', block);
        assert.ok(cont > block && cont - block < 500, 'the gate must still end in continue, after the block');
    });
});


// ─── 05 — dist pin ─────────────────────────────────────────────────────────────

describe('05 - #B956: the browser bundle carries the block', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/routing (control) and the block', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, GATE), 1, 'control: the DELETE branch must be in the bundle');
        assert.equal(count(dist, BLOCK), 1, 'the rebuilt bundle must carry the block');
    });
});
