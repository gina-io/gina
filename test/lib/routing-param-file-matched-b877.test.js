'use strict';
/**
 * #B877 — a `:placeholder` in `param.file` that is a URL segment takes the URL value, not a query or
 * body value of the same name.
 *
 * On the request path, `lib/routing` filled a matched route's placeholders from the request data
 * alone (`checkRouteParams(params, request[method])`), and the URL value reached that bag only when
 * the client had not sent the key. `fitsWithRequirements` consumes the URL value into `param.path`,
 * `.namespace` and `.title` at match time, but its `param.file` rewrite never matched (its pattern
 * doubled the colon of a `urlVar` that already starts with `:`). So `/s/page?name=other`, on a route
 * whose requirement allows only `page`, rendered `content/other`: the request chose a template the
 * route's requirement was meant to rule out. The fix feeds `checkRouteParams` the request data
 * overlaid by the values the route matched (`request.params`), so every fill still passes the #B833
 * guard; the never-matching rewrite is commented out.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers bootstrap
 * (the routing-replacers-b688 shape) — no replica to drift. Seam: `B877_FW=<framework dir>` loads
 * another tree's framework (for example the pre-fix main worktree), for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — a URL-segment placeholder takes the URL value (fix-sensitive)
 *  03 — the request data itself is untouched (holds on both revisions)
 *  04 — a query key folded in by its requirement still fills its placeholder (holds on both)
 *  05 — the overlay keeps a `__proto__` key an ordinary property (holds on both)
 *  06 — source pins (comment-stripped, fix-sensitive)
 *  07 — dist pin: the browser bundle carries the fixed call site (lib/routing is bundled)
 *
 * Red-first: run against the pre-fix framework before the fix landed (develop `cfa27f723`,
 * 2026-10-15) — suites 02, 06 and 07 red, the others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B877_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    // a URL segment with a requirement, the placeholder in param.file (the #B877 shape)
    'strict@b': { method: 'GET', url: '/s/:name', bundle: 'b', requirements: { name: '/^(page)$/' },
                  param: { control: 'show', name: ':name', file: 'content/:name' } },
    // a URL segment without a requirement
    'free@b':   { method: 'GET', url: '/f/:name', bundle: 'b',
                  param: { control: 'show', name: ':name', file: 'content/:name' } },
    // a placeholder the URL does not carry, no requirement: the request selects the template
    'tpl@b':    { method: 'GET', url: '/t', bundle: 'b',
                  param: { control: 'show', tpl: ':tpl', file: 'content/:tpl' } },
    // a query key the requirement folds in as a segment (GET): filled from its validated value
    'fold@b':   { method: 'GET', url: '/k', bundle: 'b', requirements: { tpl: '/.+/' },
                  param: { control: 'show', tpl: ':tpl', file: 'content/:tpl' } },
    // two placeholders: one a URL segment, one not
    'mixed@b':  { method: 'GET', url: '/m/:name', bundle: 'b', requirements: { name: '/^(page)$/' },
                  param: { control: 'show', name: ':name', lang: ':lang', file: ':lang/:name' } }
};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));
var commentStrip = require('../strip-comments');

/**
 * Match `url` against a rule the way the engine does (server.js builds this route description), with
 * `get` as the request's query data.
 *
 * @inner
 * @param {string} name - a key of TABLE
 * @param {string} url - the request path
 * @param {object} [get] - the request's query data (copied)
 * @returns {Promise<{past: boolean, file: (string|undefined), req: object}>}
 */
async function match(name, url, get) {
    var rule = TABLE[name];
    var req  = { url: url, method: 'GET', headers: {}, params: { 0: url }, get: get || {} };
    var params = {
        method: rule.method, control: rule.param.control, requirements: rule.requirements, url: url,
        rule: name, param: JSON.clone(rule.param), middleware: [], bundle: 'b'
    };
    var out = await routing.compareUrls(params, rule.url, req, {}, function () {});
    var p   = (req.routing && req.routing.param) || {};
    return { past: !!(out && out.past), file: p.file, req: req };
}

/**
 * The source with its comments removed: full-line `//` comments and `/* … *\/` blocks.
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

var NEW_CALL  = 'request.routing = checkRouteParams(params, fillValuesOf(request[method], request.params));';
var OLD_CALL  = 'checkRouteParams(params, request[method]);';
var DEAD_FILE = 'params.param.file = params.param.file.replace( _regex, replacement );';
var GUARD_MSG = /\[CVE-2023-25345\] Path traversal attempt blocked in route param `(name|tpl)`/;


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B877: the instrument and the controls', function () {

    it('01.1  a URL value its requirement rejects does not match (the known negative)', async function () {
        assert.equal((await match('strict@b', '/s/zzz')).past, false);
    });

    it('01.2  the URL value fills param.file when the request sends nothing (the known positive)', async function () {
        var r = await match('strict@b', '/s/page');
        assert.equal(r.past, true);
        assert.equal(r.file, 'content/page');
    });

    it('01.3  an unrelated query key changes nothing', async function () {
        assert.equal((await match('strict@b', '/s/page', { foo: '1' })).file, 'content/page');
    });

    it('01.4  a placeholder the URL does not carry is filled from the query', async function () {
        assert.equal((await match('tpl@b', '/t', { tpl: 'other' })).file, 'content/other');
        assert.equal((await match('tpl@b', '/t')).file, 'content/:tpl', 'no query value: the placeholder stays');
    });

    it('01.5  the #B833 guard still refuses an escaping URL value', async function () {
        await assert.rejects(match('free@b', '/f/..\\..\\x'), GUARD_MSG);
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B877: a URL-segment placeholder in param.file takes the URL value', function () {

    it('02.1  a same-name query value no longer replaces a requirement-validated segment', async function () {
        var r = await match('strict@b', '/s/page', { name: 'other' });
        assert.equal(r.past, true);
        assert.equal(r.file, 'content/page');
    });

    it('02.2  nor a segment on a route without a requirement', async function () {
        assert.equal((await match('free@b', '/f/foo', { name: 'bar' })).file, 'content/foo');
    });

    it('02.3  with two placeholders, the URL one takes the URL value and the other the query value', async function () {
        assert.equal((await match('mixed@b', '/m/page', { lang: 'fr', name: 'other' })).file, 'fr/page');
    });

    it('02.4  an escaping same-name query value is ignored: the URL value fills param.file', async function () {
        var r = await match('strict@b', '/s/page', { name: '..\\..\\x' });
        assert.equal(r.past, true);
        assert.equal(r.file, 'content/page');
    });
});


// ─── 03 — the request data itself is untouched ────────────────────────────────

describe('03 - #B877: req.get keeps the client value, req.params the URL value', function () {

    it('03.1  both stay what they were before the fix', async function () {
        var r = await match('strict@b', '/s/page', { name: 'other' });
        assert.equal(r.req.get.name, 'other');
        assert.equal(r.req.params.name, 'page');
    });
});


// ─── 04 — a query key folded in by its requirement ────────────────────────────

describe('04 - #B877: a query key folded in by its requirement still fills its placeholder', function () {

    it('04.1  the validated query value fills param.file', async function () {
        var r = await match('fold@b', '/k', { tpl: 'home' });
        assert.equal(r.past, true);
        assert.equal(r.file, 'content/home');
    });

    it('04.2  and the #B833 guard still refuses an escaping one', async function () {
        await assert.rejects(match('fold@b', '/k', { tpl: '..\\..\\x' }), GUARD_MSG);
    });
});


// ─── 05 — a `__proto__` key stays an ordinary property ────────────────────────

describe('05 - #B877: a request key named __proto__ never becomes a prototype', function () {

    it('05.1  a placeholder no key fills stays a placeholder', async function () {
        var get = {};
        Object.defineProperty(get, '__proto__', { value: { tpl: 'evil' }, writable: true, enumerable: true, configurable: true });
        var r = await match('tpl@b', '/t', get);
        assert.equal(r.past, true);
        assert.equal(r.file, 'content/:tpl');
    });
});


// ─── 06 — source pins ──────────────────────────────────────────────────────────

describe('06 - #B877: source — the call site overlays the matched values; the dead rewrite is gone', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('06.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.ok(live.indexOf('var checkRouteParams = function(route, params)') > -1, 'the strip must keep checkRouteParams');
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });

    it('06.2  the request path feeds checkRouteParams the overlay, never the request data alone', function () {
        assert.ok(live.indexOf('var fillValuesOf = function(data, matched)') > -1, 'fillValuesOf must exist');
        assert.equal(count(live, NEW_CALL), 1);
        assert.equal(count(live, OLD_CALL), 0);
    });

    it('06.3  the never-matching param.file rewrite is out of live code', function () {
        assert.equal(count(live, DEAD_FILE), 0);
        assert.ok(count(raw, DEAD_FILE) >= 1, 'control: the raw source keeps it in a `was:` comment, so 06.3 cannot pass on a broken strip');
    });
});


// ─── 07 — dist pin ─────────────────────────────────────────────────────────────

describe('07 - #B877: the browser bundle carries the fixed call site', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('07.1  the unminified bundle carries lib/routing (control), the overlay call and no dead rewrite', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('var checkRouteParams = function(route, params)') > -1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, NEW_CALL), 1, 'the rebuilt bundle must carry the overlay call');
        assert.equal(count(dist, DEAD_FILE), 0, 'the rebuilt bundle must not carry the dead rewrite');
    });
});
