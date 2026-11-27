/**
 * #B1164 / #B1104 — what a render-cache entry stores and a response a cache may keep carries.
 *
 * #B1164: since #B1132 the output cache keys a page on its request variant (the culture its
 * `Accept-Language` or culture cookie selects, its forwarded host, scheme and prefix), yet a
 * cached route's response (`Cache-Control: <visibility>, max-age=`, on a miss and on a hit)
 * carried no `Vary`, so a browser reused a page for its whole `max-age` after the language
 * changed. `RenderCache.VARY_HEADERS` names those request headers once; `appendVariantVary()`
 * appends them to a response's `Vary` (the delegates and both hit paths call it) and
 * `instance.set()` appends them to the stored `vary` of an entry keyed on a variant.
 *
 * #B1104: a hit replayed the filling request's `Access-Control-Allow-Origin`.
 * `RenderCache.RECOMPUTED_HEADERS` names it; `instance.set()` never stores it, and the replay
 * loops skip it (pinned in test/core/render-cache-vary-acao-b1164.test.js).
 *
 * The per-request list (`PER_REQUEST_HEADERS`, #B1100 and #B1105) is a separate one: those headers are dropped, these are
 * recomputed or appended, so they live in their own lists.
 *
 * Run standalone:
 *   node --test test/lib/render-cache-vary-recompute-b1164.test.js
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

var NAMES = 'Accept-Language, Cookie, X-Forwarded-Host, X-Forwarded-Proto, X-Forwarded-Prefix';

/** A stored snapshot as `res.getHeaders()` returns it (lowercase keys). */
function snapshot() {
    return {
        'content-type'                : 'text/html; charset=utf-8',
        'vary'                        : 'Origin',
        'access-control-allow-origin' : 'http://oa.example',
        'set-cookie'                  : ['token=abc; Path=/'],
        'x-request-id'                : 'req-of-the-filler'
    };
}

/** A fake response: records headers by lowercase name, like node's. */
function fakeResponse(initial, sent) {
    var h = {};
    Object.keys(initial || {}).forEach(function (k) { h[k.toLowerCase()] = initial[k]; });
    return {
        headersSent : !!sent,
        sets        : 0,
        getHeader   : function (n) { return h[n.toLowerCase()]; },
        setHeader   : function (n, v) { this.sets++; h[n.toLowerCase()] = v; },
        headers     : h
    };
}

function freshRc() {
    var rc = new RenderCache();
    rc.from(new Map());
    return rc;
}

var tmpRoot;
before(function () { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-cache-b1164-')); });
after(function () { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } });


describe('01 - #B1164 the variant request headers and the Vary merge', function () {

    it('VARY_HEADERS names the five request headers the variant reads, in this order', function () {
        assert.deepEqual(RenderCache.VARY_HEADERS, ['Accept-Language', 'Cookie', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Prefix']);
    });

    it('mergeVary appends after the names already listed, keeping their order and case', function () {
        assert.equal(RenderCache.mergeVary('Origin', RenderCache.VARY_HEADERS), 'Origin, ' + NAMES);
        assert.equal(RenderCache.mergeVary(undefined, RenderCache.VARY_HEADERS), NAMES);
        assert.equal(RenderCache.mergeVary(null, 'Cookie'), 'Cookie');
        assert.equal(RenderCache.mergeVary('', 'Cookie'), 'Cookie');
    });

    it('mergeVary adds no name already listed, in any case, and nothing after a *', function () {
        assert.equal(RenderCache.mergeVary('Origin, accept-language', ['Accept-Language', 'ORIGIN', 'Cookie']), 'Origin, accept-language, Cookie');
        assert.equal(RenderCache.mergeVary('*', RenderCache.VARY_HEADERS), '*');
        assert.equal(RenderCache.mergeVary('Origin, *', 'Cookie'), 'Origin, *');
        assert.equal(RenderCache.mergeVary('Origin', ''), 'Origin');
        assert.equal(RenderCache.mergeVary(undefined, undefined), '');
    });

    it('mergeVary takes arrays and comma lists on both sides', function () {
        assert.equal(RenderCache.mergeVary(['Origin', 'Accept-Encoding'], 'Cookie,  X-Forwarded-Host'), 'Origin, Accept-Encoding, Cookie, X-Forwarded-Host');
        assert.equal(RenderCache.mergeVary('Origin', ['Cookie, Accept-Language', 'Cookie']), 'Origin, Cookie, Accept-Language');
    });

    it('appendVariantVary appends the five names after a configured Vary', function () {
        var res = fakeResponse({ 'Vary': 'Origin' });
        RenderCache.appendVariantVary(res);
        assert.equal(res.headers['vary'], 'Origin, ' + NAMES);
    });

    it('appendVariantVary sets them on a response without Vary, and a second call changes nothing', function () {
        var res = fakeResponse({});
        RenderCache.appendVariantVary(res);
        assert.equal(res.headers['vary'], NAMES);
        var sets = res.sets;
        RenderCache.appendVariantVary(res);
        assert.equal(res.headers['vary'], NAMES);
        assert.equal(res.sets, sets, 'no second write when every name is listed');
    });

    it('appendVariantVary does nothing once the headers are sent, or on what is not a response', function () {
        var res = fakeResponse({ 'vary': 'Origin' }, true);
        RenderCache.appendVariantVary(res);
        assert.equal(res.headers['vary'], 'Origin');
        assert.equal(res.sets, 0);
        assert.doesNotThrow(function () { RenderCache.appendVariantVary(null); });
        assert.doesNotThrow(function () { RenderCache.appendVariantVary({}); });
    });
});


describe('02 - #B1104 the headers a hit recomputes', function () {

    it('RECOMPUTED_HEADERS names exactly access-control-allow-origin, lowercase', function () {
        assert.deepEqual(RenderCache.RECOMPUTED_HEADERS, ['access-control-allow-origin']);
    });

    it('isRecomputedHeader matches it in any case, and nothing else', function () {
        ['access-control-allow-origin', 'Access-Control-Allow-Origin', 'ACCESS-CONTROL-ALLOW-ORIGIN'].forEach(function (n) {
            assert.equal(RenderCache.isRecomputedHeader(n), true, n);
        });
        ['access-control-allow-methods', 'access-control-allow-credentials', 'vary', 'set-cookie', '', null, undefined, 7].forEach(function (n) {
            assert.equal(RenderCache.isRecomputedHeader(n), false, String(n));
        });
    });

    it('omitRecomputedHeaders returns a new object without it, keeping every other header', function () {
        var src = snapshot(), before = JSON.stringify(src);
        var out = RenderCache.omitRecomputedHeaders(src);
        assert.notEqual(out, src);
        assert.equal('access-control-allow-origin' in out, false);
        assert.equal(out['vary'], 'Origin');
        assert.deepEqual(out['set-cookie'], ['token=abc; Path=/'], 'the #B1100 list is not this one');
        assert.equal(JSON.stringify(src), before, 'the input is not mutated');
        assert.equal(RenderCache.omitRecomputedHeaders(null), null);
    });

    it('CONTROL: the per-request list is #B1100\'s and #B1105\'s, not this one', function () {
        assert.deepEqual(RenderCache.PER_REQUEST_HEADERS, ['set-cookie', 'x-request-id', 'ratelimit', 'ratelimit-policy']);
        assert.equal(RenderCache.isPerRequestHeader('access-control-allow-origin'), false);
    });
});


describe('03 - #B1164 withVariantVary on a stored snapshot', function () {

    it('appends the five names to its vary, in a new object', function () {
        var src = { 'content-type': 'text/html', 'vary': 'Origin' }, before = JSON.stringify(src);
        var out = RenderCache.withVariantVary(src);
        assert.notEqual(out, src);
        assert.deepEqual(out, { 'content-type': 'text/html', 'vary': 'Origin, ' + NAMES });
        assert.equal(JSON.stringify(src), before, 'the input is not mutated');
    });

    it('adds a lowercase vary to a snapshot without one, and merges a mixed-case Vary key in place', function () {
        assert.deepEqual(RenderCache.withVariantVary({ 'content-type': 'application/json' }), { 'content-type': 'application/json', 'vary': NAMES });
        assert.deepEqual(RenderCache.withVariantVary({ 'Vary': 'Accept-Encoding' }), { 'Vary': 'Accept-Encoding, ' + NAMES });
    });

    it('passes a non-object through', function () {
        assert.equal(RenderCache.withVariantVary(null), null);
        assert.equal(RenderCache.withVariantVary(undefined), undefined);
    });
});


describe('04 - instance.set(): no stored ACAO, and the variant names in the stored Vary, on every strategy', function () {
    var rc;
    beforeEach(function () { rc = freshRc(); });
    afterEach(function () { try { rc.clear(); } catch (e) { /* ignore */ } });

    var EXPECTED = { 'content-type': 'text/html; charset=utf-8', 'vary': 'Origin, ' + NAMES };

    it('memory: an entry keyed on a variant', async function () {
        var src = snapshot(), before = JSON.stringify(src);
        await rc.set('memory', 'static:demo:/b1164-m', { variant: '|/|fr', responseHeaders: src }, { content: '<p>m</p>' });
        assert.deepEqual(rc.get('static:demo:/b1164-m').responseHeaders, EXPECTED);
        assert.equal(JSON.stringify(src), before, 'the caller\'s snapshot is not mutated');
    });

    it('fs: the entry and its .meta sidecar', async function () {
        var key = 'static:demo:/b1164-fs';
        await rc.set('fs', key, { variant: '|/|fr', responseHeaders: snapshot() }, { content: '<p>fs</p>', path: tmpRoot, bundle: 'demo', url: '/b1164-fs', kind: 'html' });
        var hit = rc.get(key);
        assert.deepEqual(hit.responseHeaders, EXPECTED);
        var raw = fs.readFileSync(String(hit.filename) + '.meta', 'utf8');
        assert.deepEqual(JSON.parse(raw).responseHeaders, EXPECTED);
        assert.equal(/access-control-allow-origin|oa\.example/i.test(raw), false, 'no trace of the filler\'s origin in the file');
    });

    it('redis: L1 and the L2 value', async function () {
        var l2 = {
            values: Object.create(null),
            set: function (k, v) { l2.values[k] = v; return Promise.resolve(); },
            warmRead: function () { return Promise.resolve(null); },
            del: function () { return Promise.resolve(0); }
        };
        var rcr = new RenderCache({ l2: l2 });
        rcr.from(new Map());
        var key = rcr.buildKey('static', 'demo', '/b1164-redis');
        await rcr.set('redis', key, { variant: '|/|fr', visibility: 'public', responseHeaders: snapshot() }, { content: 'HTML' });
        assert.deepEqual(rcr.get(key).responseHeaders, EXPECTED, 'L1');
        assert.deepEqual(JSON.parse(l2.values[key]).responseHeaders, EXPECTED, 'L2');
        try { rcr.clear(); } catch (e) { /* ignore */ }
    });

    it('an entry without a variant: the ACAO is still dropped, and no name is added to Vary', async function () {
        await rc.set('memory', 'static:demo:/b1164-nv', { responseHeaders: snapshot() }, { content: '{}' });
        assert.deepEqual(rc.get('static:demo:/b1164-nv').responseHeaders, { 'content-type': 'text/html; charset=utf-8', 'vary': 'Origin' });
    });

    it('CONTROL: an entry without a variant, an ACAO or a per-request header is stored unchanged', async function () {
        await rc.set('memory', 'static:demo:/b1164-ctl', { responseHeaders: { 'content-type': 'application/json', 'x-a': '1' } }, { content: '{}' });
        assert.deepEqual(rc.get('static:demo:/b1164-ctl').responseHeaders, { 'content-type': 'application/json', 'x-a': '1' });
    });
});
