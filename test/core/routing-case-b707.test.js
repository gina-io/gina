/**
 * #B707 — on the isaac engine, one GET of the client routing map spelled in another letter case
 * (`/_gina/assets/Routing.json`) no longer ends the bundle.
 *
 * The defect: isaac's routing-map fast path tests the url with a case-insensitive regex, then looks
 * the asset up by the name that regex captured — the request's own spelling — through an
 * exact-match `findOne`. The asset is registered as `routing.json`, so any other spelling found
 * nothing, and the `localAsset.mime` read below dereferenced null: an uncaughtException that ended
 * the process (measured exit 143). Unauthenticated, one request, before routing and every route
 * guard.
 *
 * The fix: the captured name is lower-cased before the lookup, so every spelling the matcher
 * accepts names the registered asset. #P48 reshaped the fast path: it matches the url's PATH
 * (`_routingPath`, the query-free url), looks up that path's last segment lower-cased through a
 * ternary, and a miss leaves `localAsset` null so the request falls through to core/server.js —
 * a missing asset is never dereferenced.
 *
 * Instrument: isaac's matcher condition and its asset lookup are EXTRACTED from the shipped source
 * and EXECUTED — no replica. The lookup runs against a collection stub that answers exactly like
 * the real one (a strict `===` on the file name, `lib/collection`), with `routing.json` as the only
 * registered name. The extraction anchors are #P48's statements (`var _routingPath =`, the
 * `localAsset = (` ternary), so a tree without #P48 fails at extraction; the behavioural red-first
 * is the live twin's. The lowercase path is the control, and a longer name the matcher must reject
 * is the negative control.
 *
 * Red-first seam (the #B498 harness name): GINA_ISAAC_SRC points the file at another tree's
 * server.isaac.js.
 *
 * Run standalone:
 *   node --test test/core/routing-case-b707.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW        = require('../fw');
var ISAAC_SRC = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var ISAAC     = fs.readFileSync(ISAAC_SRC, 'utf8');

// the matcher's regex text as it appears in the source (escaped), unique in the file
var MATCHER_NEEDLE = '_gina\\/assets\\/routing\\.json';


// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// isaac (#P48): the query-free `_routingPath` is computed in its own statement, then the lookup is
// assigned through a ternary on the matcher; both statements are extracted and executed together.
var NEEDLE = MATCHER_NEEDLE;
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

/** A collection holding the one registered name, compared strictly like lib/collection's findOne. */
function lookup(url) {
    var asked = [];
    var found = ISAAC_ROUTING_LOOKUP({ method: 'GET', url: url }, {
        findOne: function (q) {
            asked.push(q.file);
            return ( q.file === 'routing.json' ) ? { file: 'routing.json', mime: 'application/json; charset=utf8' } : null;
        }
    });
    return { asked: asked, found: found };
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('#B707 00 — isaac\'s routing-map fast path: the extraction holds', function () {

    it('00.1  the matcher and the lookup are found once, below each other', function () {
        assert.equal(typeof ISAAC_ROUTING_COND, 'function');
        assert.equal(typeof ISAAC_ROUTING_LOOKUP, 'function');
    });
});

describe('#B707 01 — control: the lowercase path', function () {

    it('01.1  GET /_gina/assets/routing.json enters the fast path and finds the registered asset', function () {
        var url = '/_gina/assets/routing.json';
        assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: url }), true, 'the matcher must accept ' + url);
        var r = lookup(url);
        assert.deepEqual(r.asked, ['routing.json']);
        assert.ok(r.found, 'the registered asset must be found');
    });
});

describe('#B707 02 — a spelling in another letter case finds the registered asset (was null, then `localAsset.mime` threw)', function () {

    [
        '/_gina/assets/Routing.json',
        '/_gina/assets/ROUTING.JSON',
        '/web/_gina/assets/RoUtInG.JsOn',
        '/_gina/assets/Routing.json?x=1'
    ].forEach(function (url) {
        it('02  GET ' + url + ' — the matcher accepts it, and the lookup asks for routing.json', function () {
            // the matcher is case-insensitive: this request DOES enter the fast path (the vector)
            assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: url }), true, 'the matcher must accept ' + url);
            var r = lookup(url);
            assert.deepEqual(r.asked, ['routing.json'], 'the lookup must ask for the registered name, whatever the spelling');
            assert.ok(r.found, 'the asset must be found, or `localAsset.mime` below throws and ends the process');
        });
    });
});

describe('#B707 03 — negative control: the matcher still rejects what it rejected', function () {

    it('03.1  a longer name, another path, a path in the query string (#P48) and a POST do not enter the fast path', function () {
        [ '/_gina/assets/Routing.jsonx', '/_gina/assets/Routing.json/x', '/x?y=/_gina/assets/Routing.json' ].forEach(function (url) {
            assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: url }), false, url);
        });
        assert.equal(ISAAC_ROUTING_COND({ method: 'POST', url: '/_gina/assets/Routing.json' }), false, 'POST');
    });
});

describe('#B707 04 — a lookup miss falls through (#P48): nothing is dereferenced', function () {

    it('04.1  a collection without the asset leaves localAsset null, and the null guard follows the lookup', function () {
        var asked = [];
        var found = ISAAC_ROUTING_LOOKUP({ method: 'GET', url: '/_gina/assets/Routing.json' }, {
            findOne: function (q) { asked.push(q.file); return null; }
        });
        assert.deepEqual(asked, ['routing.json'], 'the lookup still asks for the registered name');
        assert.equal(found, null, 'a miss must leave localAsset null');
        assert.equal(ISAAC_ROUTING.after.replace(/^\s+/, '').indexOf('if ( localAsset ) {'), 0,
            'the statement after the lookup must be the null guard, so a miss falls through to core/server.js');
    });
});
