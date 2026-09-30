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
 * accepts names the registered asset.
 *
 * Instrument: isaac's matcher condition and its asset lookup are EXTRACTED from the shipped source
 * and EXECUTED — no replica. The lookup runs against a collection stub that answers exactly like
 * the real one (a strict `===` on the file name, `lib/collection`), with `routing.json` as the only
 * registered name. Every extraction anchor exists once in the source before and after the fix, so a
 * red run fails on behaviour, never on a missing anchor; the lowercase path is the control, and a
 * longer name the matcher must reject is the negative control.
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

/** The condition of the `if (…) {` that holds the unique matcher needle. */
function conditionAround(src, needle, label) {
    var at = src.indexOf(needle);
    assert.ok(at > -1, label + ': matcher anchor not found: ' + needle);
    assert.equal(src.indexOf(needle, at + 1), -1, label + ': the matcher anchor must be unique');
    var ifAt    = src.lastIndexOf('if (', at);
    var closeAt = src.indexOf(') {', at);
    assert.ok(ifAt > -1 && closeAt > at, label + ': could not bound the condition');
    return src.slice(ifAt + 'if ('.length, closeAt);
}

var ISAAC_ROUTING_COND = new Function('request', 'return !!(' + conditionAround(ISAAC, MATCHER_NEEDLE, 'isaac routing.json') + '\n);');

// the asset lookup statement below the matcher, executed on its own
var ISAAC_ROUTING_LOOKUP = (function () {
    var at   = ISAAC.indexOf(MATCHER_NEEDLE);
    var from = ISAAC.indexOf('localAsset = assetsCollection.findOne({ file:', at);
    var to   = (from > -1) ? ISAAC.indexOf('});', from) : -1;
    assert.ok(at > -1 && from > at && to > from, 'isaac routing.json: the asset lookup was not found below the matcher');
    return new Function('request', 'assetsCollection', 'var localAsset; ' + ISAAC.slice(from, to + 3) + '\nreturn localAsset;');
})();

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
        '/_gina/assets/Routing.json?x=1',
        '/x?y=/_gina/assets/Routing.json'
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

    it('03.1  a longer name, another path and a POST do not enter the fast path', function () {
        [ '/_gina/assets/Routing.jsonx', '/_gina/assets/Routing.json/x' ].forEach(function (url) {
            assert.equal(ISAAC_ROUTING_COND({ method: 'GET', url: url }), false, url);
        });
        assert.equal(ISAAC_ROUTING_COND({ method: 'POST', url: '/_gina/assets/Routing.json' }), false, 'POST');
    });
});
