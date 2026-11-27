/**
 * #B1105 — a render-cache hit never replays the rate-limit standing of the caller whose
 * request filled the entry.
 *
 * The router's rate-limit gate (#MS6) sets `RateLimit` (the caller's remaining count) and
 * `RateLimit-Policy` on an identified caller's allowed request. A render delegate stored them
 * with the rest of `res.getHeaders()`, and every hit replayed them: a later visitor, anonymous
 * or another user, read the remaining count of the caller who filled the entry (measured on a
 * booted bundle, 2026-11-25). A hit answers before the gate, so it is not counted, and it now
 * carries neither header: `RenderCache.PER_REQUEST_HEADERS` names both, so `instance.set()`
 * drops them for every strategy and both replay loops skip them, entries stored by older
 * releases included (the loops are pinned in test/core/render-cache-replay-per-request-b1100.test.js).
 *
 * Run standalone:
 *   node --test test/lib/render-cache-ratelimit-b1105.test.js
 */

var fs   = require('fs');
var os   = require('os');
var path = require('path');
var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

// the fs strategy uses the `_` PathObject global
require(path.join(FW, 'helpers'));

var RenderCache = require(path.join(FW, 'lib/render-cache/src/main'));

/** A stored snapshot of a rate-limited page, as `res.getHeaders()` returns it: lowercase keys. */
function snapshot() {
    return {
        'content-type'     : 'text/html; charset=utf-8',
        'cache-control'    : 'public, max-age=60',
        'ratelimit'        : '"default";r=98',
        'ratelimit-policy' : '"default";q=100;w=60'
    };
}

var KEPT = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' };

/**
 * A render cache over a fresh in-memory Map.
 *
 * @inner
 * @returns {object} A RenderCache instance
 *
 * @example
 * var rc = freshRc(); // rc.set('memory', key, entry, payload)
 */
function freshRc() {
    var rc = new RenderCache();
    rc.from(new Map());
    return rc;
}

var tmpRoot;
before(function () { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-cache-b1105-')); });
after(function () { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } });


describe('01 - the per-request list names the two rate-limit headers', function () {

    it('PER_REQUEST_HEADERS holds ratelimit and ratelimit-policy, lowercase', function () {
        assert.ok(RenderCache.PER_REQUEST_HEADERS.indexOf('ratelimit') > -1, 'ratelimit');
        assert.ok(RenderCache.PER_REQUEST_HEADERS.indexOf('ratelimit-policy') > -1, 'ratelimit-policy');
    });

    it('isPerRequestHeader matches them in any case', function () {
        ['ratelimit', 'RateLimit', 'RATELIMIT', 'ratelimit-policy', 'RateLimit-Policy'].forEach(function (n) {
            assert.equal(RenderCache.isPerRequestHeader(n), true, n);
        });
    });

    it('control: neighbouring names stay out of the list', function () {
        ['retry-after', 'ratelimit-limit', 'x-ratelimit', 'ratelimit-policy2', 'content-type'].forEach(function (n) {
            assert.equal(RenderCache.isPerRequestHeader(n), false, n);
        });
    });

    it('omitPerRequestHeaders drops both and keeps the page headers', function () {
        var src = snapshot(), before = JSON.stringify(src);
        assert.deepEqual(RenderCache.omitPerRequestHeaders(src), KEPT);
        assert.equal(JSON.stringify(src), before, 'the input is not mutated');
    });
});


describe('02 - instance.set() stores neither header', function () {
    var rc;
    beforeEach(function () { rc = freshRc(); });
    afterEach(function () { try { rc.clear(); } catch (e) { /* ignore */ } });

    it('memory: the stored entry keeps the page headers only', async function () {
        await rc.set('memory', 'static:demo:/b1105-m', { responseHeaders: snapshot() }, { content: '<p>m</p>' });
        assert.deepEqual(rc.get('static:demo:/b1105-m').responseHeaders, KEPT);
    });

    it('fs: neither the entry nor the .meta sidecar on disk holds them', async function () {
        var key = 'static:demo:/b1105-fs';
        await rc.set('fs', key, { responseHeaders: snapshot() }, { content: '<p>fs</p>', path: tmpRoot, bundle: 'demo', url: '/b1105-fs', kind: 'html' });
        var hit = rc.get(key);
        assert.deepEqual(hit.responseHeaders, KEPT);
        var metaFile = String(hit.filename) + '.meta';
        assert.equal(fs.existsSync(metaFile), true, 'the .meta sidecar is written');
        assert.equal(/ratelimit|r=98/i.test(fs.readFileSync(metaFile, 'utf8')), false, 'no trace of them in the file');
    });
});
