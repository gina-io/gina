'use strict';
/**
 * #B883 — a URL value that would escape as a path component no longer reaches `param.path` or
 * `param.namespace` past the #B833 router guard.
 *
 * `fitsWithRequirements` writes the URL value into `param.path`, `.namespace` and `.title` before
 * the route's requirement test, so those placeholders never reached `checkRouteParams`, where the
 * #B833 guard (`_isUnsafePathValue`) rejects a value holding a `..` segment or starting with a
 * separator. A URL segment (`/q/..\..\x`), or a query key that its requirement folds in as a
 * segment (`/n?ns=..\..\x`), therefore filled both fields unchecked; only the render boundary
 * (#B867) or the async loader's identifier check refused it later. The early rewrite now skips such
 * a value, so its placeholder survives to the guarded fill and the router throws
 * `[CVE-2023-25345] … in route param`. The value is tested before `regex.test()`, whose `lastIndex`
 * a skipped rewrite would otherwise leave advanced.
 *
 * Decided effect (Martin Luther ETOUMAN NDAMBWE, 2026-10-15): a redirect route that takes
 * `param.path` from a query key its requirement folds in, with a value starting with `/`, now
 * answers like its no-requirement twin has since 0.7.4 — the guard throws (suite 03).
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers bootstrap
 * (the routing-replacers-b688 shape) — no replica to drift. Seam: `B883_FW=<framework dir>` loads
 * another tree's framework (for example the tree before this fix), for its pins AND its arms.
 *
 * Suites:
 *  01 — the instrument and the controls (hold before and after the fix)
 *  02 — an escaping URL value in param.path / param.namespace is refused (fix-sensitive)
 *  03 — the redirect target taken from a folded query key (fix-sensitive, decided)
 *  04 — source pins (comment-stripped, fix-sensitive)
 *  05 — dist pin: the browser bundle carries the fixed conditions (lib/routing is bundled)
 *
 * Red-first: run against the #B877 tree before this fix (2026-10-15) — suites 02, 03.1, 04.2,
 * 04.3 and 05 red, the others green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW          = process.env.B883_FW || require('../fw');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// Bare-module resolution + JSON.clone + the framework globals lib/routing expects.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }

var TABLE = {
    // a URL segment in param.path, no requirement
    'seg@b':    { method: 'GET', url: '/q/:pth', bundle: 'b',
                  param: { control: 'show', pth: ':pth', path: '/x/:pth' } },
    // the same with a requirement: a value it rejects skips the route
    'segreq@b': { method: 'GET', url: '/r/:pth', bundle: 'b', requirements: { pth: '/^[a-z]+$/' },
                  param: { control: 'show', pth: ':pth', path: '/x/:pth' } },
    // a URL segment in param.namespace, with a title placeholder beside it
    'nsseg@b':  { method: 'GET', url: '/m/:ns', bundle: 'b',
                  param: { control: 'show', ns: ':ns', namespace: ':ns', title: 'T :ns' } },
    // a query key the requirement folds in as a segment (GET), in param.namespace
    'nsfold@b': { method: 'GET', url: '/n', bundle: 'b', requirements: { ns: '/.+/' },
                  param: { control: 'show', ns: ':ns', namespace: ':ns' } },
    // param.path and param.title fed by one URL segment, the title placeholder first in its string
    'pt@b':     { method: 'GET', url: '/pt/:pth', bundle: 'b',
                  param: { control: 'show', pth: ':pth', path: '/x/:pth', title: ':pth title' } },
    // a URL segment in param.file: the #B833 guard's own case (the control)
    'file@b':   { method: 'GET', url: '/fl/:pth', bundle: 'b',
                  param: { control: 'show', pth: ':pth', file: 'content/:pth' } },
    // a redirect target taken from a query key its requirement folds in
    'gofold@b': { method: 'GET', url: '/go', bundle: 'b', requirements: { next: '/^\\/[a-z]+$/' },
                  param: { control: 'redirect', next: ':next', path: ':next' } },
    // its no-requirement twin: the placeholder reaches checkRouteParams from the query
    'gofree@b': { method: 'GET', url: '/go2', bundle: 'b',
                  param: { control: 'redirect', next: ':next', path: ':next' } }
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
 * @returns {Promise<{past: boolean, path: (string|undefined), namespace: (string|undefined), title: (string|undefined), file: (string|undefined)}>}
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
    return { past: !!(out && out.past), path: p.path, namespace: p.namespace, title: p.title, file: p.file };
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

var NEW_PATH = 'if (params.param.path && !_isUnsafePathValue(urlVal) && regex.test(params.param.path)) {';
var NEW_NS   = 'if (params.param.namespace && !_isUnsafePathValue(urlVal) && regex.test(params.param.namespace)) {';
var OLD_PATH = 'if (params.param.path && regex.test(params.param.path)) {';
var OLD_NS   = 'if (params.param.namespace && regex.test(params.param.namespace)) {';

/**
 * The #B833 guard's message for `variable`.
 *
 * @inner
 * @param {string} variable
 * @returns {RegExp}
 */
function guardFor(variable) {
    return new RegExp('\\[CVE-2023-25345\\] Path traversal attempt blocked in route param `' + variable + '`');
}


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B883: the instrument and the controls', function () {

    it('01.1  a safe URL value fills param.path (the known positive)', async function () {
        var r = await match('seg@b', '/q/abc');
        assert.equal(r.past, true);
        assert.equal(r.path, '/x/abc');
    });

    it('01.2  a safe value fills param.path and param.title together', async function () {
        var r = await match('pt@b', '/pt/abc');
        assert.equal(r.path, '/x/abc');
        assert.equal(r.title, 'abc title');
    });

    it('01.3  a safe folded query value fills param.namespace', async function () {
        var r = await match('nsfold@b', '/n', { ns: 'docs' });
        assert.equal(r.past, true);
        assert.equal(r.namespace, 'docs');
    });

    it('01.4  a value its requirement rejects still skips the route (the known negative)', async function () {
        assert.equal((await match('segreq@b', '/r/..\\x')).past, false);
        assert.equal((await match('segreq@b', '/r/abc')).path, '/x/abc', 'control: an accepted value matches');
    });

    it('01.5  the #B833 guard refuses an escaping URL value in param.file (the guard fires)', async function () {
        await assert.rejects(match('file@b', '/fl/..\\..\\x'), guardFor('pth'));
    });

    it('01.6  the no-requirement redirect twin: a query target starting with `/` is refused since 0.7.4', async function () {
        await assert.rejects(match('gofree@b', '/go2', { next: '/dashboard' }), guardFor('next'));
        assert.equal((await match('gofree@b', '/go2', { next: 'dashboard' })).path, 'dashboard', 'control: a relative target fills');
    });
});


// ─── 02 — the fix ──────────────────────────────────────────────────────────────

describe('02 - #B883: an escaping URL value never fills param.path or param.namespace', function () {

    it('02.1  a `..` segment in a URL value for param.path is refused', async function () {
        await assert.rejects(match('seg@b', '/q/..\\..\\x'), guardFor('pth'));
    });

    it('02.2  a bare `..` and a leading backslash are refused too', async function () {
        await assert.rejects(match('seg@b', '/q/..'), guardFor('pth'));
        await assert.rejects(match('seg@b', '/q/\\x'), guardFor('pth'));
    });

    it('02.3  a URL value for param.namespace is refused', async function () {
        await assert.rejects(match('nsseg@b', '/m/..\\x'), guardFor('ns'));
    });

    it('02.4  a folded query value for param.namespace is refused', async function () {
        await assert.rejects(match('nsfold@b', '/n', { ns: '..\\..\\x' }), guardFor('ns'));
    });

    it('02.5  a value feeding param.path and a title placed first in its string is refused', async function () {
        await assert.rejects(match('pt@b', '/pt/..\\x'), guardFor('pth'));
    });
});


// ─── 03 — the redirect target taken from a folded query key ───────────────────

describe('03 - #B883: a folded query target starting with `/` is refused, like its twin', function () {

    it('03.1  `?next=/dashboard` on a route whose requirement folds `next` in throws', async function () {
        await assert.rejects(match('gofold@b', '/go', { next: '/dashboard' }), guardFor('next'));
    });

    it('03.2  a value the requirement rejects still skips the route', async function () {
        assert.equal((await match('gofold@b', '/go', { next: 'dashboard' })).past, false);
    });
});


// ─── 04 — source pins ──────────────────────────────────────────────────────────

describe('04 - #B883: source — the early rewrites test the value first', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);

    it('04.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.ok(live.indexOf('var fitsWithRequirements = async function(') > -1, 'the strip must keep fitsWithRequirements');
        assert.ok(live.indexOf('var _isUnsafePathValue = function(value){') > -1, 'the strip must keep _isUnsafePathValue');
        assert.equal(stripComments('    // was: a(b);\n    y\n').indexOf('a(b)'), -1, 'the strip must remove a full-line comment');
    });

    it('04.2  the path and namespace rewrites carry the value check before regex.test()', function () {
        assert.equal(count(live, NEW_PATH), 1);
        assert.equal(count(live, NEW_NS), 1);
    });

    it('04.3  the unchecked conditions are out of live code', function () {
        assert.equal(count(live, OLD_PATH), 0);
        assert.equal(count(live, OLD_NS), 0);
        assert.ok(count(raw, OLD_PATH) >= 1 && count(raw, OLD_NS) >= 1,
            'control: the raw source keeps them in `was:` comments, so 04.3 cannot pass on a broken strip');
    });
});


// ─── 05 — dist pin ─────────────────────────────────────────────────────────────

describe('05 - #B883: the browser bundle carries the fixed conditions', function () {

    var dist = fs.existsSync(DIST_JS) ? stripComments(fs.readFileSync(DIST_JS, 'utf8')) : null;

    it('05.1  the unminified bundle carries lib/routing (control) and both checked conditions', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('var fitsWithRequirements = async function(') > -1, 'control: lib/routing must be in the bundle');
        assert.equal(count(dist, NEW_PATH), 1, 'the rebuilt bundle must carry the checked path condition');
        assert.equal(count(dist, NEW_NS), 1, 'the rebuilt bundle must carry the checked namespace condition');
    });
});
