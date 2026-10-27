'use strict';
/**
 * #B955 — on a DELETE route whose regex requirements cover its URL placeholders, `req.params`
 * carries the URL values, as it does on every other route.
 *
 * `parseRouting` matches such a rule in its own DELETE branch (not through `fitsWithRequirements`,
 * the GET path): each placeholder's regex is tested against its URL segment and the matched value
 * was written to `request[method]` only, so `req.params.grp` / `req.params.id` stayed unset there
 * while a DELETE rule without requirements, and every GET rule, set them. The branch now writes
 * `request.params[key]` too, for a placeholder the rule binds in `param` — the gate
 * `fitsWithRequirements` applies on GET.
 *
 * Not pinned here: which value wins in `req.delete` when the client sends a same-name query key
 * (a design question, #B954); the arms send one only to show `req.params` ignores it.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers bootstrap
 * (the routing-path-namespace-unsafe-b883 shape) — no replica to drift. Seam: `B955_FW=<framework dir>`
 * loads another tree's framework (for example the tree before this fix), for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — the fix: req.params on a DELETE route with regex requirements (fix-sensitive)
 *  03 — GET parity: an unbound placeholder stays out of req.params (fix-sensitive on the bound one)
 *  04 — source pin (comment-stripped, fix-sensitive)
 *  05 — dist pin: the unminified browser bundle carries the write (lib/routing is bundled)
 *
 * Red-first: run with `B955_FW` pointing at the tree before this fix — suites 02, 03.1, 04.2 and 05
 * red, the others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B955_FW || require('../fw');
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
    // the defect's shape: DELETE, regex requirements on both placeholders, both bound in param
    'delreq@b':     { method: 'DELETE', url: '/d/:grp/:id', bundle: 'b', requirements: REQ,
                      param: { control: 'rm', grp: ':grp', id: ':id' } },
    // its twin without requirements, matched by fitsWithRequirements (the known positive)
    'delfree@b':    { method: 'DELETE', url: '/f/:grp/:id', bundle: 'b',
                      param: { control: 'rm', grp: ':grp', id: ':id' } },
    // the same shape on GET (the known positive)
    'getreq@b':     { method: 'GET', url: '/g/:grp/:id', bundle: 'b', requirements: REQ,
                      param: { control: 'show', grp: ':grp', id: ':id' } },
    // a requirement on `id`, but only `grp` bound in param: GET parity says `id` stays out of req.params
    'delunbound@b': { method: 'DELETE', url: '/u/:grp/:id', bundle: 'b', requirements: REQ,
                      param: { control: 'rm', grp: ':grp' } }
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

// The DELETE branch's write of the matched value, and the req.params write this fix adds after it.
var BRANCH_WRITE = 'request[method][uRo[p].substring(1)] = uRe[p];';
var PARAMS_WRITE = 'if ( hasOwn(params.param, _key) && typeof(request.params) != \'undefined\' ) {\n'
                 + '                            request.params[_key] = uRe[p];';


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B955: the instrument and the controls', function () {

    it('01.1  a DELETE route without requirements sets req.params from the URL (the known positive)', async function () {
        var r = await match('delfree@b', '/f/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('01.2  a GET route with the same regex requirements sets req.params (the known positive)', async function () {
        var r = await match('getreq@b', '/g/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('01.3  the DELETE route with requirements matches, and req.delete carries the URL values (unchanged)', async function () {
        var r = await match('delreq@b', '/d/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });

    it('01.4  a value its requirement rejects skips the DELETE route (the known negative)', async function () {
        assert.equal((await match('delreq@b', '/d/g1/notanumber')).past, false);
        assert.equal((await match('delreq@b', '/d/g 1/42')).past, false);
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B955: req.params on a DELETE route whose regex requirements cover its placeholders', function () {

    it('02.1  both placeholders reach req.params with the URL values', async function () {
        var r = await match('delreq@b', '/d/g1/42');
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('02.2  a same-name query key does not change req.params', async function () {
        var r = await match('delreq@b', '/d/g1/42', { id: '99', x: '1' });
        assert.equal(r.past, true);
        assert.deepEqual(r.params, { grp: 'g1', id: '42' });
    });

    it('02.3  req.params holds a copy: changing it does not touch req.delete', async function () {
        var r = await match('delreq@b', '/d/g1/42');
        r.params.id = 'changed';
        assert.equal(r.bag.id, '42');
    });
});


// ─── 03 — GET parity for an unbound placeholder ───────────────────────────────

describe('03 - #B955: a placeholder the rule does not bind in param stays out of req.params', function () {

    it('03.1  the bound placeholder reaches req.params, the unbound one does not', async function () {
        var r = await match('delunbound@b', '/u/g1/42');
        assert.equal(r.past, true, 'the route must still match: the requirement scores the unbound placeholder');
        assert.deepEqual(r.params, { grp: 'g1' });
    });

    it('03.2  control: req.delete still carries both (unchanged)', async function () {
        var r = await match('delunbound@b', '/u/g1/42');
        assert.deepEqual(r.bag, { grp: 'g1', id: '42' });
    });
});


// ─── 04 — source pin ───────────────────────────────────────────────────────────

describe('04 - #B955: source — the DELETE branch writes req.params after its req[method] write', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.equal(count(live, BRANCH_WRITE), 1, 'the DELETE branch write must be live, exactly once');
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });

    it('04.2  the req.params write follows the req[method] write, once, and the branch keeps the #B650 gate', function () {
        assert.equal(count(live, PARAMS_WRITE), 1);
        var at = live.indexOf(PARAMS_WRITE), from = live.indexOf(BRANCH_WRITE);
        assert.ok(at > from && at - from < 600, 'the req.params write must sit right after the branch write (' + (at - from) + ' chars)');
        assert.ok(live.indexOf('if ( !hasOwn(params.requirements, _key) || typeof(params.requirements[_key]) == \'undefined\' ) {') > -1,
            'control: the branch keeps its own-requirement gate');
    });
});


// ─── 05 — dist pin ─────────────────────────────────────────────────────────────

describe('05 - #B955: the browser bundle carries the write', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/routing (control) and the req.params write', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.equal(count(dist, BRANCH_WRITE), 1, 'control: the DELETE branch must be in the bundle');
        assert.equal(count(dist, PARAMS_WRITE), 1, 'the rebuilt bundle must carry the req.params write');
    });
});
