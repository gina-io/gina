'use strict';
/**
 * #B1171 — `req.routing.method` read differently on the cold and the warm path. The cold scan of
 * `_handleDispatch` (core/server.js) builds `params.method` from the RULE: its method for a
 * single-method rule, the request's method for a method list, `HEAD` for a HEAD on a GET rule.
 * A warm route-cache hit builds it in lib/routing `getCached()` from the REQUEST, lower-cased
 * (`req.method.toLowerCase()`). So a route reported `GET` on its first request per method and
 * `get` on every later one, while the routing guide documents `method : "GET"`.
 *
 * THE FIX: the first statement of `_handleDispatch`'s `if (matched)` block upper-cases
 * `req.routing.method`, before the render-cache serve, the fast lane and `router.route`.
 *
 * WHICH ARMS CAN GO RED — read this before trusting a green run:
 *   §00  premise, the REAL lib/routing: a warm hit writes the request's method lower-cased
 *        (green pre-fix too: the fix leaves getCached as it is).
 *   §01  the normalisation, extracted from the shipped source and run on stub requests:
 *        red pre-fix (no such statement).
 *   §02  source pins: it is the first statement of `if (matched)`, before the render-cache
 *        serve, the fast lane and router.route: red pre-fix.
 * The booted evidence (a cold, then a warm GET, a HEAD and a lower-case `get`, on an isaac
 * bundle) is recorded with the fix.
 *
 * Seam: `GINA_B1171_SERVER_SRC=<file>` reads that file instead of the tree's `core/server.js`,
 * so §01 and §02 run red-first against the pre-fix source.
 *
 * Run standalone:
 *   node --test test/core/route-method-b1171.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_B1171_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER     = fs.readFileSync(SERVER_SRC, 'utf8');

/** Drop full-line `//` comments, so a pin cannot be satisfied by the prose that documents it. */
function activeLines(src) {
    return src.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

var ACTIVE    = activeLines(SERVER);
var MATCHED   = '        if (matched) {\n';
var NORMALISE = "if ( req.routing && typeof(req.routing.method) == 'string' ) {";
var CLOSE     = '\n            }\n';

/**
 * The normalisation statement, extracted from the active source and compiled as a function of
 * the request it runs on.
 *
 * @returns {function(object): void} the statement
 */
function loadNormalise() {
    var s = ACTIVE.indexOf(NORMALISE);
    assert.ok(s > -1, 'the normalisation is in core/server.js');
    assert.equal(ACTIVE.indexOf(NORMALISE, s + 1), -1, 'the normalisation occurs once');
    var e = ACTIVE.indexOf(CLOSE, s);
    assert.ok(e > s, 'the normalisation closes');
    return new Function('req', "'use strict';\n" + ACTIVE.slice(s, e + CLOSE.length));
}

// ---------------------------------------------------------------------------
describe('route-method-b1171 §00 — premise: a warm hit writes the request method, lower-cased', function () {

    // the bootstrap of server-route-cache-verdict.test.js §02 (the #B215 matcher-standalone shape)
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));                              // _, setPath, setContext, ...
    require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));   // JSON.clone, Object.count()
    process.gina = process.gina || {};
    setPath('gina', { core: path.join(FW, 'core') });

    var TABLE = {
        'thing-list@test': {
            url: '/thing/a/b', method: 'GET', bundle: 'test', namespace: 'test',
            requirements: { flag: '/^(true)$/i' },
            param: { control: 'thingList', file: 'thing', title: 'Thing', flag: ':flag' }
        }
    };
    setContext('isProxyHost', false);
    setContext('gina', { config: {
        env: 'dev', bundle: 'test', envConf: {},
        getRouting: function () { return TABLE; }
    } });

    var routingLib = require(path.join(FW, 'lib/routing/src/main.js'));

    it('00.1  getCached builds req.routing.method from the request, lower-cased', async function () {
        var KEY = 'GET:/thing/a/b', name = 'thing-list@test', rule = TABLE[name];
        routingLib.invalidateCached(KEY);
        routingLib.cache(KEY, name, rule);
        var req = { url: '/thing/a/b', method: 'GET', headers: {}, routing: {}, params: { 0: '/thing/a/b' }, get: { flag: true } };
        var found = await routingLib.getCached(KEY, req);
        assert.ok(found && found.past === true, 'control: the warm hit accepts the request');
        assert.equal(rule.method, 'GET', 'control: the rule reads GET');
        assert.equal(req.routing.method, 'get');
    });
});

// ---------------------------------------------------------------------------
describe('route-method-b1171 §01 — the normalisation, extracted from the shipped source and run', function () {

    it('01.1  a lower-case method reads upper case', function () {
        var run = loadNormalise(), req = { routing: { method: 'get' } };
        run(req);
        assert.equal(req.routing.method, 'GET');
    });

    it('01.2  an upper-case method is unchanged (HEAD, a method list)', function () {
        var run = loadNormalise(), a = { routing: { method: 'HEAD' } }, b = { routing: { method: 'GET,POST' } };
        run(a); run(b);
        assert.equal(a.routing.method, 'HEAD');
        assert.equal(b.routing.method, 'GET,POST');
    });

    it('01.3  a request without req.routing, or without a string method, is left alone', function () {
        var run = loadNormalise(), a = {}, b = { routing: {} }, c = { routing: { method: null } };
        run(a); run(b); run(c);
        assert.equal(a.routing, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(b.routing, 'method'), false);
        assert.equal(c.routing.method, null);
    });
});

// ---------------------------------------------------------------------------
describe('route-method-b1171 §02 — where it sits in _handleDispatch', function () {

    it('02.1  it is the first statement of the if (matched) block', function () {
        var m = ACTIVE.indexOf(MATCHED);
        assert.ok(m > -1, 'control: _handleDispatch has its if (matched) block');
        assert.equal(ACTIVE.indexOf(MATCHED, m + 1), -1, 'control: one if (matched) block at this indentation');
        var first = ACTIVE.slice(m + MATCHED.length).replace(/^\s+/, '');
        assert.equal(first.indexOf(NORMALISE), 0, 'the first statement after if (matched) {');
    });

    it('02.2  it precedes the render-cache serve, the fast lane and router.route', function () {
        var m = ACTIVE.indexOf(MATCHED), n = ACTIVE.indexOf(NORMALISE, m);
        assert.ok(m > -1 && n > m, 'the normalisation sits inside the if (matched) block');
        [
            'tryServeRenderCacheHit(req, res, bundle)',
            'lib.lane.lookup(req.routing)',
            'return router.route(req, res, next, req.routing);'
        ].forEach(function (token) {
            var i = ACTIVE.indexOf(token, m);
            assert.ok(i > -1, 'control: ' + token + ' follows if (matched) {');
            assert.ok(n < i, 'the normalisation precedes ' + token);
        });
    });
});
