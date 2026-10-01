/**
 * #B717 + #B718 — the health check, the client routing map and the release-watch status and
 * events endpoints answer a url that carries a query string, and the health check answers HEAD,
 * on both engines.
 *
 * The defects: these handlers matched `…$` on `request.url`. isaac runs its own handlers on the
 * RAW url (its query strip sits far below), and on express core/server.js runs its `/_gina` band
 * above the #B668 strip — so `/_gina/health/check?probe=1` or `/_gina/assets/routing.json?x=1`
 * missed the handler: a 404 on express, and on isaac a 503 during a maintenance window (#B717).
 * And the health check answered GET only, so a HEAD probe — some load balancers probe with HEAD —
 * fell through to routing: a 404, or the maintenance 503 (#B718).
 *
 * The fix: the four matchers end in `(?:\?|$)` (the idiom of the instrument and agent handlers)
 * on both engines; the health check answers HEAD with the GET status and headers plus
 * `content-length`, and no body; isaac's routing.json fast path looks its asset up by the file
 * name its test matched, so a query no longer names a missing asset (whose `localAsset.mime` read
 * would have thrown). #P48 then moved the routing map to the url's PATH on both engines (a
 * versioned fetch carries `?v=<token>`; a page whose query string ends in the map's path is the
 * page's, the #B712 rule): isaac computes `_routingPath`, looks up its last segment lower-cased,
 * and a miss falls through to core/server.js.
 *
 * Instrument: each health handler block is EXTRACTED from the shipped source and EXECUTED against
 * request/response stubs — no replica, so nothing can drift from the source; the matcher
 * conditions and isaac's asset lookup are extracted and executed the same way. Every extraction
 * anchor exists once in the sources before and after the fix, so a red run fails on behaviour,
 * never on a missing anchor — except isaac's routing-map statements, which are #P48's shape (a
 * tree without #P48 fails at that extraction); a plain `GET /_gina/health/check` arm is the control.
 *
 * Red-first seam (the #B498 harness names): GINA_SERVER_SRC / GINA_ISAAC_SRC point the file at
 * another tree's sources.
 *
 * Run standalone:
 *   node --test test/core/gina-endpoints-query-head-b717.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
var ISAAC_SRC  = process.env.GINA_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js');
var SERVER     = fs.readFileSync(SERVER_SRC, 'utf8');
var ISAAC      = fs.readFileSync(ISAAC_SRC, 'utf8');


// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** The text from a unique start anchor up to the next end anchor. */
function between(src, from, to, label) {
    var a = src.indexOf(from);
    assert.ok(a > -1, label + ': start anchor not found: ' + from);
    assert.equal(src.indexOf(from, a + 1), -1, label + ': the start anchor must be unique');
    var b = src.indexOf(to, a);
    assert.ok(b > a, label + ': end anchor not found after the start: ' + to);
    return src.slice(a, b);
}

/**
 * The condition of the `if (…) {` that holds a unique needle: from the `if (` before it to the
 * `) {` after it — comments inside the condition included, so newlines are kept.
 */
function conditionAround(src, needle, label) {
    var at = src.indexOf(needle);
    assert.ok(at > -1, label + ': matcher anchor not found: ' + needle);
    assert.equal(src.indexOf(needle, at + 1), -1, label + ': the matcher anchor must be unique');
    var ifAt    = src.lastIndexOf('if (', at);
    var closeAt = src.indexOf(') {', at);
    assert.ok(ifAt > -1 && closeAt > at, label + ': could not bound the condition');
    return src.slice(ifAt + 'if ('.length, closeAt);
}

/** An expected health body length: the timestamp is always a 24-character ISO string. */
function healthBodyLength() {
    return Buffer.byteLength(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
}


// ---------------------------------------------------------------------------
// Response stubs
// ---------------------------------------------------------------------------

/** core/server.js idiom: setHeader / statusCode / end. */
function expressResponse() {
    var r = { headers: {}, statusCode: null, ended: false, endArgs: null };
    r.setHeader = function (k, v) { r.headers[String(k).toLowerCase()] = v; };
    r.end = function () { r.ended = true; r.endArgs = Array.prototype.slice.call(arguments); };
    return r;
}

/** isaac HTTP/1.1: writeHead / end. */
function isaacH1Response() {
    var r = { status: null, headers: null, ended: false, endArgs: null };
    r.writeHead = function (s, h) { r.status = s; r.headers = Object.assign({}, h); };
    r.end = function () { r.ended = true; r.endArgs = Array.prototype.slice.call(arguments); };
    return r;
}

/** isaac HTTP/2: response.stream.respond / response.stream.end. */
function isaacH2Response() {
    var r = { status: null, headers: null, ended: false, endArgs: null, stream: {} };
    r.stream.respond = function (h) { r.status = h[':status']; r.headers = Object.assign({}, h); };
    r.stream.end = function () { r.ended = true; r.endArgs = Array.prototype.slice.call(arguments); };
    return r;
}


// ---------------------------------------------------------------------------
// The extracted, executable pieces
// ---------------------------------------------------------------------------

// core/server.js: the health handler, banner to the next handler's banner
var SERVER_HEALTH = new Function('request', 'response',
    between(SERVER, '// ── /_gina/health/check — liveness probe (always-on, UNGATED)', '// ── /_gina/assets/routing.json — client routing map', 'server.js health'));

// isaac: the health handler, from the comment line above it to the metrics handler's comment
var ISAAC_HEALTH = new Function('request', 'response', '_setPoweredByHeader',
    between(ISAAC, '// TODO - check url against wroot : getContext() ?', '// /_gina/metrics — Prometheus exposition format', 'isaac health'));

function identity(h) { return h; }

var SERVER_ROUTING_COND = new Function('request', 'self', 'return !!(' + conditionAround(SERVER, '_gina\\/assets\\/routing\\.json', 'server.js routing.json') + '\n);');
// isaac (#P48): the fast path computes the query-free `_routingPath` in its own statement, then
// assigns the lookup through a ternary on the matcher — a miss leaves `localAsset` null and the
// `if ( localAsset ) {` below it falls through to core/server.js. Both statements are extracted
// and executed together; the matcher needle must sit in the ternary's condition, once in the file.
var NEEDLE = '_gina\\/assets\\/routing\\.json';
var ISAAC_ROUTING = (function () {
    var from = ISAAC.indexOf('var _routingPath = ');
    var look = (from > -1) ? ISAAC.indexOf('localAsset = (', from) : -1;
    var line = (look > -1) ? ISAAC.indexOf('\n', look) : -1;
    var end  = (line > -1) ? ISAAC.indexOf(': null;', line) : -1;
    assert.ok(from > -1 && look > from && line > look && end > line, 'isaac routing.json: the `_routingPath` statement and the lookup below it were not found');
    assert.equal(ISAAC.indexOf('var _routingPath = ', from + 1), -1, 'isaac routing.json: `_routingPath` must be computed once');
    var computePath = ISAAC.slice(from, ISAAC.indexOf(';', from) + 1);
    var cond        = ISAAC.slice(look + 'localAsset = '.length, line).trim();
    var lookup      = ISAAC.slice(look, end + ': null;'.length);
    assert.ok(cond.indexOf(NEEDLE) > -1, 'isaac routing.json: the matcher must be the lookup\'s condition');
    assert.equal(ISAAC.indexOf(NEEDLE, ISAAC.indexOf(NEEDLE) + 1), -1, 'isaac routing.json: the matcher anchor must be unique');
    return {
        cond:   new Function('request', computePath + '\nreturn !!' + cond + ';'),
        lookup: new Function('request', 'assetsCollection', 'var localAsset; ' + computePath + '\n' + lookup + '\nreturn localAsset;'),
        after:  ISAAC.slice(end + ': null;'.length)
    };
})();
var ISAAC_ROUTING_COND   = ISAAC_ROUTING.cond;
var ISAAC_ROUTING_LOOKUP = ISAAC_ROUTING.lookup;

var RELEASE = {};
[ ['server.js', SERVER], ['server.isaac.js', ISAAC] ].forEach(function (pair) {
    RELEASE[pair[0]] = {
        status: new Function('lib', 'request', 'return !!(' + conditionAround(pair[1], '^\\/_gina\\/release\\/status', pair[0] + ' release/status') + '\n);'),
        events: new Function('lib', 'request', 'return !!(' + conditionAround(pair[1], '^\\/_gina\\/release\\/events', pair[0] + ' release/events') + '\n);')
    };
});

function releaseLib(active) { return { releaseWatch: { isActive: function () { return active; } } }; }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('#B717/#B718 01 — core/server.js health check: query string and HEAD', function () {

    it('01.1  control — GET /_gina/health/check answers 200 with the healthy JSON', function () {
        var res = expressResponse();
        SERVER_HEALTH({ method: 'GET', url: '/_gina/health/check' }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.endArgs.length, 1, 'a GET answers a body');
        assert.equal(JSON.parse(res.endArgs[0]).status, 'healthy');
    });

    it('01.2  GET with a query string answers 200 (#B717 — was a 404 on express)', function () {
        var res = expressResponse();
        SERVER_HEALTH({ method: 'GET', url: '/_gina/health/check?probe=1' }, res);
        assert.equal(res.ended, true, 'the handler must answer a url with a query string');
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.endArgs[0]).status, 'healthy');
    });

    it('01.3  HEAD answers 200, the same headers plus content-length, and no body (#B718)', function () {
        var get = expressResponse(), head = expressResponse();
        SERVER_HEALTH({ method: 'GET',  url: '/_gina/health/check' }, get);
        SERVER_HEALTH({ method: 'HEAD', url: '/_gina/health/check' }, head);
        assert.equal(head.ended, true, 'the handler must answer HEAD');
        assert.equal(head.statusCode, 200);
        assert.equal(head.endArgs.length, 0, 'a HEAD answer carries no body');
        assert.equal(Number(head.headers['content-length']), healthBodyLength(), 'content-length is the length of the GET body');
        ['content-type', 'cache-control', 'pragma', 'expires'].forEach(function (k) {
            assert.equal(head.headers[k], get.headers[k], 'HEAD keeps the GET ' + k);
        });
    });

    it('01.4  HEAD with a query string answers 200 and no body', function () {
        var res = expressResponse();
        SERVER_HEALTH({ method: 'HEAD', url: '/_gina/health/check?probe=1' }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.endArgs.length, 0);
    });

    it('01.5  POST, and a longer path, still fall through', function () {
        [ ['POST', '/_gina/health/check'], ['GET', '/_gina/health/checkx'], ['GET', '/_gina/health/check/x'], ['HEAD', '/_gina/health/checkx'] ].forEach(function (c) {
            var res = expressResponse();
            SERVER_HEALTH({ method: c[0], url: c[1] }, res);
            assert.equal(res.ended, false, c[0] + ' ' + c[1] + ' must not be answered by the health handler');
        });
    });
});

describe('#B717/#B718 02 — isaac health check: query string and HEAD, HTTP/1.1 and HTTP/2', function () {

    it('02.1  control — GET /_gina/health/check answers 200 with the healthy JSON (h1 and h2)', function () {
        var h1 = isaacH1Response(), h2 = isaacH2Response();
        ISAAC_HEALTH({ method: 'GET', url: '/_gina/health/check' }, h1, identity);
        ISAAC_HEALTH({ method: 'GET', url: '/_gina/health/check' }, h2, identity);
        assert.equal(h1.status, 200);
        assert.equal(JSON.parse(h1.endArgs[0]).status, 'healthy');
        assert.equal(h2.status, 200);
        assert.equal(JSON.parse(h2.endArgs[0]).status, 'healthy');
    });

    it('02.2  GET with a query string is answered by isaac\'s own handler (#B717)', function () {
        var res = isaacH1Response();
        ISAAC_HEALTH({ method: 'GET', url: '/_gina/health/check?probe=1' }, res, identity);
        assert.equal(res.ended, true, 'the handler must answer a url with a query string');
        assert.equal(res.status, 200);
    });

    it('02.3  HEAD on HTTP/1.1: writeHead(200) with content-length, then end() with no body (#B718)', function () {
        var get = isaacH1Response(), head = isaacH1Response();
        ISAAC_HEALTH({ method: 'GET',  url: '/_gina/health/check' }, get, identity);
        ISAAC_HEALTH({ method: 'HEAD', url: '/_gina/health/check' }, head, identity);
        assert.equal(head.ended, true, 'the handler must answer HEAD');
        assert.equal(head.status, 200);
        assert.equal(head.endArgs.length, 0, 'a HEAD answer carries no body');
        assert.equal(Number(head.headers['content-length']), healthBodyLength());
        ['content-type', 'cache-control', 'pragma', 'expires'].forEach(function (k) {
            assert.equal(head.headers[k], get.headers[k], 'HEAD keeps the GET ' + k);
        });
    });

    it('02.4  HEAD on HTTP/2: respond({:status 200, content-length}), then end() with no body (#B718)', function () {
        var res = isaacH2Response();
        ISAAC_HEALTH({ method: 'HEAD', url: '/_gina/health/check?probe=1' }, res, identity);
        assert.equal(res.ended, true, 'the handler must answer HEAD over HTTP/2');
        assert.equal(res.status, 200);
        assert.equal(res.endArgs.length, 0, 'a HEAD answer carries no body');
        assert.equal(Number(res.headers['content-length']), healthBodyLength());
        assert.equal(res.headers['content-type'], 'application/json; charset=utf8');
    });

    it('02.5  POST, and a longer path, still fall through', function () {
        [ ['POST', '/_gina/health/check'], ['GET', '/_gina/health/checkx'], ['GET', '/_gina/health/check/x'] ].forEach(function (c) {
            var res = isaacH1Response();
            ISAAC_HEALTH({ method: c[0], url: c[1] }, res, identity);
            assert.equal(res.ended, false, c[0] + ' ' + c[1] + ' must not be answered by the health handler');
        });
    });
});

describe('#B717 03 — the routing map: a query string no longer misses either engine\'s handler', function () {

    var SELF = { _clientRoutingAssets: {} };

    it('03.1  control — the bare path matches on both engines', function () {
        assert.equal(SERVER_ROUTING_COND({ method: 'GET', url: '/_gina/assets/routing.json' }, SELF), true);
        assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: '/_gina/assets/routing.json' }), true);
    });

    it('03.2  a query string matches on both engines (#B717)', function () {
        assert.equal(SERVER_ROUTING_COND({ method: 'GET', url: '/_gina/assets/routing.json?x=1' }, SELF), true, 'server.js');
        assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: '/_gina/assets/routing.json?x=1' }), true, 'isaac');
    });

    it('03.3  a longer name or path, and a non-GET method, do not match', function () {
        [ '/_gina/assets/routing.jsonx', '/_gina/assets/routing.json/x', '/_gina/assets/routing.jsonx?y=1' ].forEach(function (u) {
            assert.equal(SERVER_ROUTING_COND({ method: 'GET', url: u }, SELF), false, 'server.js ' + u);
            assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: u }), false, 'isaac ' + u);
        });
        assert.equal(SERVER_ROUTING_COND({ method: 'POST', url: '/_gina/assets/routing.json?x=1' }, SELF), false);
        assert.equal(ISAAC_ROUTING_COND({ method: 'POST', url: '/_gina/assets/routing.json?x=1' }), false);
    });

    it('03.4  isaac looks its asset up by the query-free path\'s file name (#B717, #P48)', function () {
        function lookup(url) {
            var asked = [];
            var found = ISAAC_ROUTING_LOOKUP({ method: 'GET', url: url }, {
                findOne: function (q) { asked.push(q.file); return ( q.file === 'routing.json' ) ? { file: q.file, mime: 'application/json' } : null; }
            });
            return { asked: asked, found: found };
        }
        var bare = lookup('/_gina/assets/routing.json');
        assert.deepEqual(bare.asked, ['routing.json'], 'control — the bare path');
        assert.ok(bare.found);
        var q = lookup('/_gina/assets/routing.json?x=1');
        assert.deepEqual(q.asked, ['routing.json'], 'a query string must not become part of the asset name');
        assert.ok(q.found, 'the asset must be found, or `localAsset.mime` below throws');
        // #P48 — the map is matched on the url's PATH on both engines, like the other /_gina/
        // endpoints since #B712: a url whose QUERY ends with the path is the page's. It was served
        // the map until #P48; now neither engine matches it, and isaac looks nothing up.
        var inQuery = '/x?y=/_gina/assets/routing.json';
        assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: inQuery }), false, 'isaac must not enter its fast path');
        assert.equal(SERVER_ROUTING_COND({ method: 'GET', url: inQuery }, SELF), false, 'core/server.js must not answer with the map');
        var iq = lookup(inQuery);
        assert.deepEqual(iq.asked, [], 'a path in the query string must not reach the lookup');
        assert.equal(iq.found, null);
    });
});

describe('#B717 04 — release/status and release/events: a query string no longer misses either engine\'s handler', function () {

    [ 'server.js', 'server.isaac.js' ].forEach(function (engine) {
        [ 'status', 'events' ].forEach(function (ep) {
            var cond = RELEASE[engine][ep];
            var base = '/_gina/release/' + ep;

            it('04  ' + engine + ' ' + ep + ': the bare path (control) and a query string match; ^-anchoring and the gates hold', function () {
                assert.equal(cond(releaseLib(true), { method: 'GET', url: base }), true, 'control — the bare path');
                assert.equal(cond(releaseLib(true), { method: 'GET', url: base + '?x=1' }), true, 'a query string must match (#B717)');
                assert.equal(cond(releaseLib(true), { method: 'GET', url: base + 'x' }), false, 'a longer name must not match');
                assert.equal(cond(releaseLib(true), { method: 'GET', url: '/foo' + base + '?x=1' }), false, 'still ^-anchored (RW-F9)');
                assert.equal(cond(releaseLib(true), { method: 'POST', url: base + '?x=1' }), false, 'still GET only');
                assert.equal(cond(releaseLib(false), { method: 'GET', url: base + '?x=1' }), false, 'still absent when the watch is not armed');
            });
        });
    });
});
