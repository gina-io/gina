'use strict';
/**
 * #B650 — a query key named like an `Object.prototype` member no longer counts as a route
 * requirement.
 *
 * For a GET or DELETE request on a rule that declares `requirements`, `parseRouting` walks
 * the request's own keys (`for (let p in request[method])`) and treats every key naming a
 * requirement that is not bound as a whole `:key` URL segment as an extra URL variable,
 * written over the compared segments from index 0. The requirement test was
 * `typeof(params.requirements[p]) != 'undefined'` — and `p` is chosen by the client: a
 * query key named `toString`, `valueOf`, `toLocaleString` or `isPrototypeOf` resolved the
 * INHERITED function and read as a declared requirement. Each such key replaced one leading
 * segment (the first replaces the always-empty leading position, the second the webroot,
 * the third the next segment…), and `fitsWithRequirements` then tested its value against
 * `new RegExp(String(Object.prototype.<name>))`, which a value shaped like the function's
 * own source passes. A request therefore reached a rule whose path differs from its own —
 * past any path-based control applied outside the rule — and the action received
 * `req.params.toString` as a string.
 *
 * Strategy: the REAL `lib/routing` (`compareUrls`), loaded through the framework's helpers
 * bootstrap (the validator-proxy-conf-clone-b522 shape) — no replica to drift. The crafted
 * values are derived from THIS engine's own `String(Object.prototype[name])`, and suite 01's
 * instrument arm proves each one passes the inherited pattern here, so the arms stay
 * meaningful on V8 and on JavaScriptCore alike.
 *
 * Suites:
 *  01 — the instrument and the controls (green before and after the fix)
 *  02 — crafted keys no longer reach a rule through another path (fix-sensitive)
 *  03 — `req.params` keeps its own methods (fix-sensitive)
 *  04 — source pin: the phantom loop tests the rule's OWN requirements (comment-stripped)
 *  05 — dist pin: the browser bundle carries the fixed loop (lib/routing is bundled)
 *
 * Red-first: suites 02–05 were run against the unfixed tree before the fix landed (record:
 * `todo/b650-design.md`); suite 01 must hold on both revisions.
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

var TABLE = {};
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return TABLE; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));

var RULES = {
    api:    { url: '/app/api/foo',         method: 'GET',    param: { control: 'act' },               requirements: { id: '/^[0-9]+$/' } },
    admin:  { url: '/app/admin/users/:id', method: 'GET',    param: { control: 'act', id: ':id' },    requirements: { id: '/^[0-9]+$/' } },
    bar:    { url: '/app/api/bar',         method: 'GET',    param: { control: 'act' } },
    search: { url: '/app/search',          method: 'GET',    param: { control: 'act', q: ':q' },      requirements: { q: '/^[a-z]+$/' } },
    del:    { url: '/app/items/:id',       method: 'DELETE', param: { control: 'act', id: ':id' },    requirements: { id: '/^[0-9]+$/' } }
};

var K2 = ['toString', 'valueOf'];
var K3 = K2.concat('toLocaleString');
var K4 = K3.concat('isPrototypeOf');

/**
 * A value that passes `new RegExp(String(Object.prototype[name]))` on THIS engine: the
 * function's own source with its empty `()` group dropped and its `[native code]` class
 * reduced to one member.
 *
 * @inner
 * @param {string} name - an Object.prototype member
 * @returns {string}
 */
function craft(name) {
    return String(Object.prototype[name]).replace('()', '').replace('[native code]', 'n');
}

/**
 * A request bag carrying one crafted value per name.
 *
 * @inner
 * @param {string[]} names
 * @param {object} [extra] - own keys to add
 * @returns {object}
 */
function crafted(names, extra) {
    var bag = Object.assign({}, extra || {});
    names.forEach(function (n) { bag[n] = craft(n); });
    return bag;
}

/**
 * Runs the real `compareUrls` for one rule, as the cold routing loop does.
 *
 * @inner
 * @param {string} name - a key of RULES
 * @param {string} method - the request method
 * @param {string} url - the request path
 * @param {object} [bag] - the request's `req[method]` payload
 * @returns {Promise<{past: boolean, req: object}>}
 */
async function match(name, method, url, bag) {
    var rule = RULES[name], m = method.toLowerCase();
    var req = { url: url, method: method, headers: {}, params: { 0: url } };
    req[m] = Object.assign({}, bag || {});
    var params = {
        method: rule.method, control: rule.param.control, requirements: rule.requirements, url: url,
        rule: name + '@b', param: JSON.clone(rule.param), middleware: [], bundle: 'b'
    };
    var out = await routing.compareUrls(params, rule.url, req, {}, function () {});
    return { past: !!(out && out.past), req: req };
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


// ─── 01 — the instrument and the controls ─────────────────────────────────────

describe('01 - #B650: the instrument and the controls (hold before and after the fix)', function () {

    it('01.1  each crafted value passes its inherited "requirement" pattern on this engine (the instrument)', function () {
        K4.forEach(function (n) {
            assert.ok(new RegExp(String(Object.prototype[n])).test(craft(n)),
                'the crafted ' + n + ' value must pass new RegExp(String(Object.prototype.' + n + ')) — otherwise suite 02 proves nothing');
        });
    });

    it('01.2  the exact paths reach their rules', async function () {
        assert.equal((await match('admin', 'GET', '/app/admin/users/42')).past, true);
        assert.equal((await match('api', 'GET', '/app/api/foo')).past, true);
        assert.equal((await match('del', 'DELETE', '/app/items/5')).past, true);
    });

    it('01.3  another path does not, with no query or with plain values under the same names', async function () {
        assert.equal((await match('admin', 'GET', '/app/public/users/42')).past, false);
        assert.equal((await match('admin', 'GET', '/app/public/users/42', { toString: '1', valueOf: '2', toLocaleString: '3' })).past, false);
    });

    it('01.4  a rule without requirements ignores crafted keys', async function () {
        assert.equal((await match('bar', 'GET', '/app/xyz/bar', crafted(K3))).past, false);
    });

    it('01.5  a requirement the rule declares still gates a key carried in the query', async function () {
        assert.equal((await match('search', 'GET', '/app/search', { q: 'abc' })).past, true, 'a valid declared key');
        assert.equal((await match('search', 'GET', '/app/search', { q: '123' })).past, false, 'an invalid declared key');
        assert.equal((await match('search', 'GET', '/app/search')).past, true, 'the key absent');
        assert.equal((await match('search', 'GET', '/app/search', crafted(K2, { q: 'abc' }))).past, true,
            'inherited-name keys beside a valid declared key do not stop the rule on its own path');
    });
});


// ─── 02 — crafted keys no longer reach a rule through another path ────────────

describe('02 - #B650: inherited-name query keys no longer replace URL segments', function () {

    it('02.1  three keys: /app/public/users/42 no longer reaches /app/admin/users/:id', async function () {
        assert.equal((await match('admin', 'GET', '/app/public/users/42', crafted(K3))).past, false);
    });

    it('02.2  two keys: a path outside the webroot no longer reaches /app/api/foo', async function () {
        assert.equal((await match('api', 'GET', '/zzz/api/foo', crafted(K2))).past, false);
    });

    it('02.3  three keys: /app/xyz/foo no longer reaches /app/api/foo', async function () {
        assert.equal((await match('api', 'GET', '/app/xyz/foo', crafted(K3))).past, false);
    });

    it('02.4  four keys: /a/b/users/44 no longer reaches /app/admin/users/:id', async function () {
        assert.equal((await match('admin', 'GET', '/a/b/users/44', crafted(K4))).past, false);
    });

    it('02.5  a valid declared key plus two inherited-name keys no longer swap the webroot', async function () {
        assert.equal((await match('search', 'GET', '/zzz/search', crafted(K2, { q: 'abc' }))).past, false);
    });

    it('02.6  DELETE: four keys no longer make a shorter path reach /app/items/:id', async function () {
        assert.equal((await match('del', 'DELETE', '/x/5', crafted(K4))).past, false);
    });
});


// ─── 03 — req.params keeps its own methods ────────────────────────────────────

describe('03 - #B650: the request keeps its methods', function () {

    it('03.1  a match on its own path with crafted keys leaves req.params.toString a function', async function () {
        var r = await match('admin', 'GET', '/app/admin/users/42', crafted(K3));
        assert.equal(r.past, true, 'control: the exact path still matches');
        assert.equal(typeof r.req.params.toString, 'function', 'req.params.toString must not be overwritten by a query value');
        assert.equal(typeof r.req.params.valueOf, 'function', 'req.params.valueOf must not be overwritten by a query value');
    });
});


// ─── 04 — source pin ──────────────────────────────────────────────────────────

describe('04 - #B650: source — the phantom loop tests the rule\'s OWN requirements', function () {

    var raw  = fs.readFileSync(ROUTING_SRC, 'utf8');
    var live = stripComments(raw);
    var FIXED = /if \( hasOwn\(params\.requirements, p\) && typeof\(params\.requirements\[p\]\) != 'undefined' && uRo\.indexOf\(':' \+ p\) < 0 \) \{/;

    it('04.1  control: the strip keeps live code and removes comments (the instrument)', function () {
        assert.ok(raw.indexOf('for (let p in request[method])') > -1, 'the phantom loop must exist in the raw source');
        assert.ok(live.indexOf('for (let p in request[method])') > -1, 'the strip must keep live code');
        assert.equal(stripComments('    // was: x\n    y\n').indexOf('was: x'), -1, 'the strip must remove a full-line comment');
        assert.equal(FIXED.test("if ( typeof(params.requirements[p]) != 'undefined' && uRo.indexOf(':' + p) < 0 ) {"), false,
            'the pin must not match the unfixed condition');
    });

    it('04.2  the live condition carries the own-property test', function () {
        assert.ok(FIXED.test(live), 'the phantom loop must test hasOwn(params.requirements, p) in live code');
    });

    it('04.3  the helper is an own-property test, not an Object.hasOwn call (the file is bundled through Closure)', function () {
        assert.ok(/var hasOwn = function\(obj, key\) \{[\s\S]{0,200}?Object\.prototype\.hasOwnProperty\.call\(obj, key\)/.test(live),
            'hasOwn must delegate to Object.prototype.hasOwnProperty.call');
    });
});


// ─── 05 — dist pin ────────────────────────────────────────────────────────────

describe('05 - #B650: the browser bundle carries the fixed loop', function () {

    var dist = fs.existsSync(DIST_JS) ? fs.readFileSync(DIST_JS, 'utf8') : null;

    it('05.1  the unminified bundle carries lib/routing (control) and the fixed condition', function () {
        assert.ok(dist, 'gina.js must be present at ' + DIST_JS);
        assert.ok(dist.indexOf('for (let p in request[method])') > -1, 'control: lib/routing must be in the bundle');
        assert.ok(dist.indexOf("if ( hasOwn(params.requirements, p) && typeof(params.requirements[p]) != 'undefined'") > -1,
            'the rebuilt bundle must carry the #B650 condition');
    });
});
