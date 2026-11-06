/**
 * #B1100 / #B1101 — a render-cache entry never stores the filling request's per-request
 * response headers.
 *
 * A render delegate stores `res.getHeaders()` when it fills the output cache. That snapshot
 * held the filling request's `X-Request-Id` and its `Set-Cookie` (a token cookie set by
 * middleware before the render included), and every hit replayed them to the visitors that
 * came after. `lib/render-cache` now names those headers once (`RenderCache.PER_REQUEST_HEADERS`)
 * and `instance.set()` drops them before any strategy stores the entry: the memory Map, the
 * fs strategy's `.meta` sidecar on disk, the redis L2 value. Both replay loops skip the same
 * names (pinned in test/core/render-cache-replay-per-request-b1100.test.js), so an entry stored
 * by an older release is harmless too.
 *
 * Run standalone:
 *   node --test test/lib/render-cache-per-request-headers-b1100.test.js
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

/** A stored snapshot as `res.getHeaders()` returns it: lowercase keys, the cookie list an array. */
function snapshot() {
    return {
        'content-type'    : 'text/html; charset=utf-8',
        'x-frame-options' : 'SAMEORIGIN',
        'set-cookie'      : ['token=abc.def; Path=/; SameSite=Lax', 'pref=1; Path=/'],
        'x-request-id'    : 'req-of-the-filler'
    };
}

var KEPT = { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN' };

function freshRc() {
    var rc = new RenderCache();
    rc.from(new Map());
    return rc;
}

var tmpRoot;
before(function () { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-cache-b1100-')); });
after(function () { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } });


describe('01 - the per-request header list and its predicates', function () {

    it('names exactly set-cookie and x-request-id, lowercase', function () {
        assert.deepEqual(RenderCache.PER_REQUEST_HEADERS, ['set-cookie', 'x-request-id']);
    });

    it('isPerRequestHeader matches those names in any case, and nothing else', function () {
        ['set-cookie', 'Set-Cookie', 'SET-COOKIE', 'x-request-id', 'X-Request-Id'].forEach(function (n) {
            assert.equal(RenderCache.isPerRequestHeader(n), true, n);
        });
        ['content-type', 'cache-control', 'content-security-policy', 'x-request-identity', 'set-cookie2', '', null, undefined, 42].forEach(function (n) {
            assert.equal(RenderCache.isPerRequestHeader(n), false, String(n));
        });
    });

    it('omitPerRequestHeaders returns a new object without them, keeping every other header', function () {
        var src = snapshot(), before = JSON.stringify(src);
        var out = RenderCache.omitPerRequestHeaders(src);
        assert.notEqual(out, src, 'a new object');
        assert.deepEqual(out, KEPT);
        assert.equal(JSON.stringify(src), before, 'the input is not mutated');
    });

    it('omitPerRequestHeaders drops mixed-case names too, and passes a non-object through', function () {
        assert.deepEqual(RenderCache.omitPerRequestHeaders({ 'Set-Cookie': 'a=1', 'X-Request-Id': 'r', 'Vary': 'Accept' }), { 'Vary': 'Accept' });
        assert.equal(RenderCache.omitPerRequestHeaders(null), null);
        assert.equal(RenderCache.omitPerRequestHeaders(undefined), undefined);
    });
});


describe('02 - instance.set() stores no per-request header, on every strategy', function () {
    var rc;
    beforeEach(function () { rc = freshRc(); });
    afterEach(function () { try { rc.clear(); } catch (e) { /* ignore */ } });

    it('memory: the stored entry keeps the page headers and drops the cookie and the id', async function () {
        var src = snapshot(), before = JSON.stringify(src);
        await rc.set('memory', 'static:demo:/b1100-m', { responseHeaders: src }, { content: '<p>m</p>' });
        var hit = rc.get('static:demo:/b1100-m');
        assert.deepEqual(hit.responseHeaders, KEPT);
        assert.equal(hit.content, '<p>m</p>');
        assert.equal(JSON.stringify(src), before, 'the caller\'s snapshot is not mutated');
    });

    it('fs: neither the entry nor the .meta sidecar on disk holds the cookie or the id', async function () {
        var key = 'static:demo:/b1100-fs';
        await rc.set('fs', key, { responseHeaders: snapshot() }, { content: '<p>fs</p>', path: tmpRoot, bundle: 'demo', url: '/b1100-fs', kind: 'html' });
        var hit = rc.get(key);
        assert.deepEqual(hit.responseHeaders, KEPT);
        var metaFile = String(hit.filename) + '.meta';
        assert.equal(fs.existsSync(metaFile), true, 'the .meta sidecar is written');
        var raw = fs.readFileSync(metaFile, 'utf8');
        assert.deepEqual(JSON.parse(raw).responseHeaders, KEPT);
        assert.equal(/set-cookie|x-request-id|req-of-the-filler|token=abc/i.test(raw), false, 'no trace of them in the file');
    });

    it('fs: a read-back after a restart (a fresh instance on the same root) replays no cookie or id', async function (t) {
        // a ttl arms a lib/cache timer: mock it, or the file keeps the event loop alive
        t.mock.timers.enable(['setTimeout']);
        var key = 'static:demo:/b1100-rb';
        await rc.set('fs', key, { ttl: 300, responseHeaders: snapshot() }, { content: '<p>rb</p>', path: tmpRoot, bundle: 'demo', url: '/b1100-rb', kind: 'html' });
        var restarted = new RenderCache().from(new Map(), tmpRoot);
        var hit = restarted.get(key);
        assert.ok(hit, 'the entry is read back from disk');
        assert.deepEqual(hit.responseHeaders, KEPT);
        try { restarted.clear(); } catch (e) { /* ignore */ }
    });

    it('redis: neither L1 nor the L2 value holds the cookie or the id', async function () {
        var l2 = {
            values: Object.create(null),
            set: function (k, v) { l2.values[k] = v; return Promise.resolve(); },
            warmRead: function () { return Promise.resolve(null); },
            del: function () { return Promise.resolve(0); }
        };
        var rcr = new RenderCache({ l2: l2 });
        rcr.from(new Map());
        var key = rcr.buildKey('static', 'demo', '/b1100-redis');
        await rcr.set('redis', key, { visibility: 'public', responseHeaders: snapshot() }, { content: 'HTML' });
        assert.deepEqual(rcr.get(key).responseHeaders, KEPT, 'L1');
        assert.ok(l2.values[key], 'the L2 value is written');
        assert.deepEqual(JSON.parse(l2.values[key]).responseHeaders, KEPT, 'L2');
        try { rcr.clear(); } catch (e) { /* ignore */ }
    });

    it('control: an entry with no per-request header is stored unchanged', async function () {
        await rc.set('memory', 'static:demo:/b1100-ctl', { responseHeaders: { 'content-type': 'application/json', 'x-a': '1' } }, { content: '{}' });
        assert.deepEqual(rc.get('static:demo:/b1100-ctl').responseHeaders, { 'content-type': 'application/json', 'x-a': '1' });
    });
});
