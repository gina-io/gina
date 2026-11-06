/**
 * #B1100 / #B1101 — a render-cache hit never replays the filling request's per-request headers.
 *
 * Two loops write a stored entry's headers onto a live response: isaac's pre-routing hit
 * (core/server.isaac.js, memory and fs entries) and `serveRenderCacheHit` (core/server.js,
 * redis entries on both engines). Both replayed every stored header, so a hit answered with the
 * filling request's `X-Request-Id` (over this request's own id, and over an inbound one) and its
 * `Set-Cookie`. Both loops now skip `RenderCache.isPerRequestHeader(h)`, which covers an entry
 * stored before the store-side strip too (an fs `.meta` sidecar, a redis L2 value). isaac's hit
 * answers before `onInstance`, where every other request gets its id, so it resolves its own
 * through a twin of server.js's `_resolveRequestId` and echoes it.
 *
 * Source pins (the replay sites are closures inside the engines; the behaviour is driven by
 * test/integration/container-boot-render-cache-headers-b1100.test.js). Comment lines are
 * removed before matching, so a comment that names the call cannot satisfy a pin.
 *
 * Run standalone:
 *   node --test test/core/render-cache-replay-per-request-b1100.test.js
 */

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW         = require('../fw');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var ISAAC_SRC  = fs.readFileSync(path.join(FW, 'core/server.isaac.js'), 'utf8');

/** The source with its whole-line comments removed (`//`, `/*`, ` *`). */
function code(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\/\*|\*)/.test(l); }).join('\n');
}

/** The text from `start` to the first `end` after it, or '' when either is missing. */
function between(src, start, end) {
    var a = src.indexOf(start);
    if ( a < 0 ) { return ''; }
    var b = src.indexOf(end, a + start.length);
    return ( b < 0 ) ? '' : src.slice(a, b + end.length);
}

describe('01 - server.js serveRenderCacheHit skips the per-request headers', function () {
    var block = between(SERVER_SRC, 'var serveRenderCacheHit', 'var tryServeRenderCacheHit');
    var loop  = between(code(block), 'for (var h in _hitHeaders)', 'res.setHeader(h, _hitHeaders[h]);');

    it('the replay loop is found (the control)', function () {
        assert.ok(block.length > 0, 'serveRenderCacheHit is found');
        assert.ok(loop.length > 0, 'its header replay loop is found');
    });

    it('the loop skips RenderCache.isPerRequestHeader(h) before it writes the header', function () {
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isPerRequestHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/);
    });
});

describe('02 - isaac pre-routing hit skips them and echoes its own id', function () {
    var src  = code(ISAAC_SRC);
    var loop = between(src, 'for (let h in _rnHeaders )', 'response.setHeader(h, _rnHeaders[h]);');
    var tail = between(src, 'response.setHeader(h, _rnHeaders[h]);', "response.setHeader('Cache-Status', cacheStatus);");

    it('the replay loop is found (the control)', function () {
        assert.ok(loop.length > 0, 'the isaac header replay loop is found');
        assert.ok(tail.length > 0, 'the Cache-Status line follows it');
    });

    it('the loop skips RenderCache.isPerRequestHeader(h) before it writes the header', function () {
        assert.match(loop, /if\s*\(\s*lib\.RenderCache\.isPerRequestHeader\(\s*h\s*\)\s*\)\s*\{\s*continue;\s*\}/);
    });

    it('between the loop and Cache-Status the hit resolves its id (first-seer) and echoes it', function () {
        assert.match(tail, /if\s*\(\s*!request\._ginaReqId\s*\)\s*\{\s*request\._ginaReqId\s*=\s*resolveRequestId\(\s*request\s*\);\s*\}/);
        assert.match(tail, /response\.setHeader\(\s*'X-Request-Id'\s*,\s*request\._ginaReqId\s*\)/);
    });
});

describe('03 - isaac\'s resolver is a twin of server.js\'s', function () {
    var serverFn = between(code(SERVER_SRC), 'var _resolveRequestId = function(request) {', '};');
    var isaacFn  = between(code(ISAAC_SRC), 'var resolveRequestId = function(request) {', '};');
    var reOf = function (fn) { var m = fn.match(/(\/\^\[[^\n]*?\$\/)\.test\(/); return m ? m[1] : null; };

    it('both resolvers are found (the control)', function () {
        assert.ok(serverFn.length > 0, 'server.js _resolveRequestId is found');
        assert.ok(isaacFn.length > 0, 'server.isaac.js resolveRequestId is found');
        assert.ok(reOf(serverFn), 'server.js sanitises with a pattern');
    });

    it('they read the same header, sanitise with the same pattern and fall back to a UUID', function () {
        assert.equal(reOf(isaacFn), reOf(serverFn));
        [serverFn, isaacFn].forEach(function (fn) {
            assert.match(fn, /request\.headers\['x-request-id'\]/);
            assert.match(fn, /return\s+crypto\.randomUUID\(\);/);
        });
    });
});
