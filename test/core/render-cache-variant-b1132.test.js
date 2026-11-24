/**
 * #B1132 — the output cache keys a page on its request variant, not on its URL alone.
 *
 * A cached route's page carries per-request values: the forwarded host and prefix
 * (`page.environment.hostname`, `.proxyHost`, `.webroot`, …) and the negotiated culture
 * (`.culture`, `.validatorLabels`, every `t` in the template). Keyed on the URL alone,
 * the first visitor's values were replayed to every later visitor for the entry's ttl.
 * The key now carries a variant — the forwarded scheme + host, the prefix, and the
 * culture the request's headers select — computed once per request, and a writer
 * refuses a page whose values the variant does not predict (a URL-prefix or middleware
 * culture, a merged-mode direct host).
 *
 * §01 buildVariant · §02 buildKey and the fs layout · §03 variantFor · §04 storableVariant
 * · §05 the three writers, extracted from the shipped sources and driven · §06 the engines
 * (isaac's stamp and read, server.js's stamp and shared read, the start() stamp, the shared
 * culture options) · §07 the redis L2 key · §08 the merged-mode mark.
 *
 * Red-first: on the tree before the fix, §01–§04 and §07 fail on the missing API, §06 and
 * §08 on the missing source, and §05's behavioural arms on their assertion: the writers
 * key two variants of one URL to ONE entry and store a page its variant does not predict.
 * The CONTROL arms pass on both trees.
 */

'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
// Bootstraps the `_` PathObject global (the fs strategy's paths) and getEnvVar / setEnvVar.
require(path.join(FW, 'helpers'));

var RenderCache = require(path.join(FW, 'lib/render-cache/src/main'));
var i18n        = require(path.join(FW, 'lib/i18n/src/main'));

function read(rel) { return fs.readFileSync(path.join(FW, rel), 'utf8'); }
var SRC = {
    isaac  : read('core/server.isaac.js'),
    server : read('core/server.js'),
    router : read('core/router.js'),
    ctrl   : read('core/controller/controller.js'),
    swig   : read('core/controller/controller.render-swig.js'),
    njk    : read('core/controller/controller.render-nunjucks.js'),
    json   : read('core/controller/controller.render-json.js')
};

var SEG_RE = /^v[0-9a-f]{32}$/;
var HOST_A = 'https://a.example.test';
var HOST_B = 'https://b.example.test';

function fresh() {
    var rc = new RenderCache();
    rc.from(new Map());
    return rc;
}
function resetEnv() {
    if (process.gina) { delete process.gina.GINA_CACHE_NAMESPACE; delete process.gina.GINA_VERSION; }
}
// The slice of `src` from `start` to the first `end` after it ('' when either is absent).
function between(src, start, end) {
    var a = src.indexOf(start);
    if (a < 0) { return ''; }
    var b = src.indexOf(end, a + start.length);
    return (b < 0) ? '' : src.slice(a, b);
}

var tmpRoot;
before(function () { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b1132-')); });
after(function () { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {} });


describe('§01 buildVariant — one variant per (host, prefix, culture)', function () {

    it('returns the parts, a readable form and a path-safe segment', function () {
        var v = RenderCache.buildVariant({ host: HOST_A, prefix: '/mnt', culture: 'fr' });
        assert.equal(v.host, HOST_A);
        assert.equal(v.prefix, '/mnt');
        assert.equal(v.culture, 'fr');
        assert.equal(v.readable, HOST_A + '|/mnt|fr');
        assert.match(v.segment, SEG_RE);
    });

    it('is stable: the same parts give the same segment', function () {
        var a = RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' });
        var b = RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' });
        assert.equal(a.segment, b.segment);
    });

    it('each part changes the segment — the host, its scheme, the prefix, the culture', function () {
        var base = RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' }).segment;
        assert.notEqual(RenderCache.buildVariant({ host: HOST_B, prefix: '', culture: 'fr' }).segment, base);
        assert.notEqual(RenderCache.buildVariant({ host: 'http://a.example.test', prefix: '', culture: 'fr' }).segment, base);
        assert.notEqual(RenderCache.buildVariant({ host: HOST_A, prefix: '/mnt', culture: 'fr' }).segment, base);
        assert.notEqual(RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'en' }).segment, base);
    });

    it('`fr` and `fr_FR` are two variants (the exact culture string)', function () {
        assert.notEqual(
            RenderCache.buildVariant({ host: '', prefix: '', culture: 'fr' }).segment,
            RenderCache.buildVariant({ host: '', prefix: '', culture: 'fr_FR' }).segment
        );
    });

    it('missing or non-string parts read as empty', function () {
        var a = RenderCache.buildVariant({ culture: 'en' });
        var b = RenderCache.buildVariant({ host: null, prefix: 7, culture: 'en' });
        assert.equal(a.readable, '||en');
        assert.equal(a.segment, b.segment);
        assert.equal(RenderCache.buildVariant().readable, '||');
    });
});


describe('§02 buildKey and the fs layout carry the segment', function () {
    var rc;
    var V = RenderCache.buildVariant ? RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' }) : { segment: 'v' + '0'.repeat(32), readable: '' };
    var W = RenderCache.buildVariant ? RenderCache.buildVariant({ host: HOST_B, prefix: '', culture: 'fr' }) : { segment: 'v' + '1'.repeat(32), readable: '' };

    beforeEach(function () { rc = fresh(); });
    afterEach(function () {
        try { rc.clear(); } catch (e) {}
        resetEnv();
    });

    it('the segment sits between the bundle and the URL', function () {
        assert.equal(rc.buildKey('static', 'demo', '/page', V), 'static:demo:' + V.segment + ':/page');
    });

    it('after the release namespace, and a URL with colons is kept whole', function () {
        setEnvVar('GINA_CACHE_NAMESPACE', 'rel1');
        assert.equal(rc.buildKey('data', 'demo', '/api?t=1:2', V), 'rel1:data:demo:' + V.segment + ':/api?t=1:2');
    });

    it('CONTROL: without a variant the key keeps the pre-#B1132 format', function () {
        assert.equal(rc.buildKey('static', 'demo', '/page'), 'static:demo:/page');
    });

    it('a value that is not a variant never reaches a key (nor, through it, a path)', function () {
        assert.equal(rc.buildKey('static', 'demo', '/page', { segment: '../x' }), 'static:demo:/page');
        assert.equal(rc.buildKey('static', 'demo', '/page', { segment: 'v' + 'g'.repeat(32) }), 'static:demo:/page');
        assert.equal(rc.buildKey('static', 'demo', '/page', 'not-a-variant'), 'static:demo:/page');
    });

    it('two variants of one URL are two keys', function () {
        assert.notEqual(rc.buildKey('static', 'demo', '/page', V), rc.buildKey('static', 'demo', '/page', W));
    });

    it('fs: the body lives under <bundle>[/<token>]/<segment>/html, and a restart reads it back', async function (t) {
        t.mock.timers.enable(['setTimeout']);
        setEnvVar('GINA_CACHE_NAMESPACE', 'relV');
        var key = rc.buildKey('static', 'vb', '/page', V);
        await rc.set('fs', key, { ttl: 300, variant: V.readable }, { content: '<p>fr</p>', path: tmpRoot, bundle: 'vb', url: '/page', kind: 'html' });
        var file = String(rc.get(key).filename);
        assert.ok(file.endsWith('/vb/relV/' + V.segment + '/html/page.html'), 'the segment is a path segment: ' + file);
        assert.equal(fs.readFileSync(file, 'utf8'), '<p>fr</p>');
        assert.equal(JSON.parse(fs.readFileSync(file + '.meta', 'utf8')).variant, V.readable, 'the readable variant rides the .meta sidecar');

        // A restart: a new instance over an empty Map, given the cache root, reads the body back.
        var restarted = new RenderCache();
        restarted.from(new Map(), tmpRoot);
        assert.equal(restarted.has(key), true);
        var back = restarted.get(key);
        assert.equal(String(back.filename), file);
        assert.equal(back.variant, V.readable, 'the read-back entry carries the readable variant');
        // Another variant of the same URL finds nothing on disk.
        assert.equal(restarted.has(restarted.buildKey('static', 'vb', '/page', W)), false);
        try { restarted.clear(); } catch (e) {}
    });

    it('fs: a URL ending in / keeps the index file name under the segment', async function (t) {
        t.mock.timers.enable(['setTimeout']);
        var key = rc.buildKey('static', 'vi', '/dir/', V);
        await rc.set('fs', key, { ttl: 300 }, { content: 'i', path: tmpRoot, bundle: 'vi', url: '/dir/', kind: 'html' });
        assert.ok(String(rc.get(key).filename).endsWith('/vi/' + V.segment + '/html/dir/index.html'));
    });

    it('memory: the readable variant rides the entry and shows in stats()', function (t) {
        t.mock.timers.enable(['setTimeout']);
        var key = rc.buildKey('static', 'vm', '/m', V);
        rc.set('memory', key, { ttl: 60, variant: V.readable }, { content: 'm' });
        var row = rc.stats().entries.filter(function (e) { return e.key === key; })[0];
        assert.ok(row, 'the entry is listed');
        assert.equal(row.variant, V.readable);
        var plain = rc.buildKey('static', 'vm', '/plain');
        rc.set('memory', plain, { ttl: 60 }, { content: 'p' });
        var prow = rc.stats().entries.filter(function (e) { return e.key === plain; })[0];
        assert.equal(Object.prototype.hasOwnProperty.call(prow, 'variant'), false, 'CONTROL: an entry without a variant lists none');
    });

    it('clear(bundle) matches a variant key, and still an old-format one', function (t) {
        t.mock.timers.enable(['setTimeout']);
        rc.set('memory', rc.buildKey('static', 'cb', '/a', V), { ttl: 60 }, { content: 'a' });
        rc.set('memory', rc.buildKey('static', 'cb', '/b'), { ttl: 60 }, { content: 'b' });
        rc.set('memory', rc.buildKey('static', 'other', '/c', V), { ttl: 60 }, { content: 'c' });
        assert.equal(rc.clear('cb'), 2);
        assert.equal(rc.has(rc.buildKey('static', 'other', '/c', V)), true, 'another bundle is kept');
    });
});


describe('§03 variantFor — the proxy slots and the culture the headers select', function () {
    var OPTS = {
        negotiate : i18n.negotiateCulture,
        i18n      : { availableCultures: ['en', 'fr'], cookieName: 'gina_culture', defaultCulture: 'en_US' },
        scheme    : 'http'
    };

    it('a proxied request (slots set by the engine): the forwarded scheme + host', function () {
        var v = RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: true, _ginaProxyHostname: HOST_A }, OPTS);
        assert.equal(v.host, HOST_A);
        assert.match(v.segment, SEG_RE);
    });

    it('a direct request: no host (the page then carries the constant config hostname)', function () {
        assert.equal(RenderCache.variantFor({ headers: { host: '127.0.0.1:3100' }, _ginaIsProxyHost: false }, OPTS).host, '');
    });

    it('the prefix comes from the slot only, never from the raw header', function () {
        assert.equal(RenderCache.variantFor({ headers: { 'x-forwarded-prefix': '/mnt' }, _ginaIsProxyHost: false }, OPTS).prefix, '');
        assert.equal(RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: false, _ginaProxyPrefix: '/mnt' }, OPTS).prefix, '/mnt');
    });

    it('culture: Accept-Language, the cookie over it, else the default', function () {
        assert.equal(RenderCache.variantFor({ headers: { 'accept-language': 'fr' }, _ginaIsProxyHost: false }, OPTS).culture, 'fr');
        assert.equal(RenderCache.variantFor({ headers: { 'accept-language': 'fr', cookie: 'gina_culture=en' }, _ginaIsProxyHost: false }, OPTS).culture, 'en');
        assert.equal(RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: false }, OPTS).culture, 'en_US');
    });

    it('a browser\'s `fr-FR,fr` matches the `fr` catalog', function () {
        var o = { negotiate: i18n.negotiateCulture, i18n: { availableCultures: ['fr'], cookieName: 'gina_culture', defaultCulture: 'fr_FR' } };
        assert.equal(RenderCache.variantFor({ headers: { 'accept-language': 'fr-FR,fr;q=0.9' }, _ginaIsProxyHost: false }, o).culture, 'fr');
        assert.equal(RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: false }, o).culture, 'fr_FR');
    });

    it('the URL prefix is never consulted: no route is known before routing', function () {
        var req = { headers: { 'accept-language': 'en' }, _ginaIsProxyHost: false, routing: { culturePrefix: true, param: { culture: 'fr' } } };
        assert.equal(RenderCache.variantFor(req, OPTS).culture, 'en');
        assert.equal(i18n.negotiateCulture(req, OPTS.i18n), 'fr', 'CONTROL: the route-aware negotiation picks the prefix');
    });

    it('without a negotiator: the request negotiation\'s own fallback (GINA_CULTURE, else en)', function () {
        assert.equal(RenderCache.variantFor({ headers: { 'accept-language': 'fr' }, _ginaIsProxyHost: false }, {}).culture, 'en');
        setEnvVar('GINA_CULTURE', 'pt-BR');
        try {
            assert.equal(RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: false }, {}).culture, 'pt_BR');
        } finally {
            delete process.gina.GINA_CULTURE;
        }
    });

    it('a negotiator that throws gives the same fallback', function () {
        var o = { negotiate: function () { throw new Error('boom'); }, i18n: OPTS.i18n };
        assert.equal(RenderCache.variantFor({ headers: {}, _ginaIsProxyHost: false }, o).culture, 'en');
    });

    describe('a slot-less engine (Express, before routing): the host is derived as core/router.js derives it', function () {
        var saved;
        beforeEach(function () {
            saved = { scheme: process.gina.PROXY_SCHEME, req: process.gina._proxyRequireForwarded };
            delete process.gina.PROXY_SCHEME;
            delete process.gina._proxyRequireForwarded;
        });
        afterEach(function () {
            if (typeof(saved.scheme) == 'undefined') { delete process.gina.PROXY_SCHEME; } else { process.gina.PROXY_SCHEME = saved.scheme; }
            if (typeof(saved.req) == 'undefined') { delete process.gina._proxyRequireForwarded; } else { process.gina._proxyRequireForwarded = saved.req; }
        });

        it('a port-less Host is proxied: X-Forwarded-Proto, else PROXY_SCHEME, else the bundle scheme', function () {
            assert.equal(RenderCache.variantFor({ headers: { host: 'a.example.test', 'x-forwarded-proto': 'https' } }, OPTS).host, 'https://a.example.test');
            assert.equal(RenderCache.variantFor({ headers: { host: 'a.example.test' } }, OPTS).host, 'http://a.example.test');
            process.gina.PROXY_SCHEME = 'https';
            assert.equal(RenderCache.variantFor({ headers: { host: 'a.example.test' } }, OPTS).host, 'https://a.example.test');
        });

        it('a host:port access is direct; X-Forwarded-Host makes it proxied', function () {
            assert.equal(RenderCache.variantFor({ headers: { host: '127.0.0.1:3100' } }, OPTS).host, '');
            assert.equal(RenderCache.variantFor({ headers: { host: '127.0.0.1:3100', 'x-forwarded-host': 'b.example.test' } }, OPTS).host, 'http://b.example.test');
        });

        it('server.proxy.requireForwardedHeaders: a port-less Host alone is not proxied', function () {
            process.gina._proxyRequireForwarded = true;
            assert.equal(RenderCache.variantFor({ headers: { host: 'a.example.test' } }, OPTS).host, '');
        });

        it('an unsafe Host, X-Forwarded-Host or X-Forwarded-Proto is ignored', function () {
            assert.equal(RenderCache.variantFor({ headers: { host: "a'b" } }, OPTS).host, '');
            assert.equal(RenderCache.variantFor({ headers: { host: '127.0.0.1:3100', 'x-forwarded-host': 'b"c' } }, OPTS).host, '');
            assert.equal(RenderCache.variantFor({ headers: { host: 'a.example.test', 'x-forwarded-proto': 'javascript' } }, OPTS).host, 'http://a.example.test');
        });

        it('twin pin: core/router.js still derives the slot as this fallback mirrors it', function () {
            assert.match(SRC.router, /var\s+_slotScheme\s*=\s*_safeXfProto\s*\|\|\s*process\.gina\.PROXY_SCHEME\s*\|\|\s*conf\.server\.scheme\s*;/);
            assert.match(SRC.router, /request\._ginaProxyHostname\s*=\s*_slotScheme\s*\+':\/\/'\+\s*_xfh\s*;/);
            assert.match(SRC.router, /\/\^\[A-Za-z0-9\._:\\\[\\\]-\]\+\$\/\.test\(v\)/);
        });
    });
});


describe('§04 storableVariant — a page is stored only under the variant it was rendered for', function () {

    function stamped(extra) {
        var req = Object.assign({ headers: {}, _ginaIsProxyHost: true, _ginaProxyHostname: HOST_A, culture: 'fr' }, extra || {});
        req._ginaCacheVariant = RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' });
        return req;
    }

    it('CONTROL: page values equal to the stamp give the stamp\'s variant', function () {
        var req = stamped();
        var v = RenderCache.storableVariant(req);
        assert.ok(v);
        assert.equal(v.segment, req._ginaCacheVariant.segment);
        assert.equal(v.readable, HOST_A + '||fr');
    });

    it('no stamp: refused', function () {
        var req = stamped();
        delete req._ginaCacheVariant;
        assert.equal(RenderCache.storableVariant(req), null);
        assert.equal(RenderCache.storableVariant(null), null);
    });

    it('a culture the headers did not select (a URL prefix, a middleware): refused', function () {
        assert.equal(RenderCache.storableVariant(stamped({ culture: 'en' })), null);
    });

    it('no culture negotiated: refused', function () {
        assert.equal(RenderCache.storableVariant(stamped({ culture: undefined })), null);
    });

    it('another host, another prefix: refused', function () {
        assert.equal(RenderCache.storableVariant(stamped({ _ginaProxyHostname: HOST_B })), null);
        assert.equal(RenderCache.storableVariant(stamped({ _ginaProxyPrefix: '/mnt' })), null);
        assert.equal(RenderCache.storableVariant(stamped({ _ginaIsProxyHost: false })), null);
    });

    it('a request the engine never classified (its page reads worker-global values): refused', function () {
        var req = stamped();
        delete req._ginaIsProxyHost;
        assert.equal(RenderCache.storableVariant(req), null);
    });

    it('proxied without a hostname slot: refused', function () {
        var req = stamped();
        delete req._ginaProxyHostname;
        assert.equal(RenderCache.storableVariant(req), null);
    });

    it('the merged-mode direct-host mark: refused', function () {
        assert.equal(RenderCache.storableVariant(stamped({ _ginaHostSpecialCase: true })), null);
    });

    it('a stamp whose segment does not match its parts: refused', function () {
        var req = stamped();
        req._ginaCacheVariant = Object.assign({}, req._ginaCacheVariant, { segment: 'v' + 'a'.repeat(32) });
        assert.equal(RenderCache.storableVariant(req), null);
    });
});


describe('§05 the three writers — keyed on the variant; a page the variant does not predict is refused', function () {

    var JSON_C = {
        parse     : JSON.parse.bind(JSON),
        stringify : JSON.stringify.bind(JSON),
        clone     : function (o) { return JSON.parse(JSON.stringify(o)); }
    };
    var LIB = { authzGate: { isRouteGated: function () { return false; } }, RenderCache: RenderCache };
    function noThrow() {}
    function res() { return { getHeaders: function () { return { 'content-type': 'text/html' }; } }; }

    function extract(src) {
        var m = src.match(/async\s+function\s+writeCache\s*\([^\)]*\)\s*\{[\s\S]*?\n\}/);
        assert.ok(m, 'writeCache is extractable');
        return m[0];
    }

    // A stub store that records each write; the key format is the real buildKey.
    function capture() {
        var real = fresh();
        var cap  = { writes: [] };
        cap.rc = {
            buildKey  : real.buildKey,
            has       : function () { return false; },
            set       : function (type, key, entry, payload) { cap.writes.push({ type: type, key: key, entry: entry, payload: payload }); return Promise.resolve(); },
            setEvents : function () { return Promise.resolve(); }
        };
        return cap;
    }

    // One driver per writer — each calls the shipped writeCache with its own signature.
    var WRITERS = {
        'render-swig': function (cap) {
            var fn = new Function('lib', 'renderCache', 'JSON', extract(SRC.swig) + '\nreturn writeCache;')(LIB, cap.rc, JSON_C);
            return function (req) { return fn('demo', { path: tmpRoot, ttl: 60 }, '<p>x</p>', req, res(), 'true', noThrow); };
        },
        'render-nunjucks': function (cap) {
            var fn = new Function('libRef', 'renderCache', 'JSON', extract(SRC.njk) + '\nreturn writeCache;')(LIB, cap.rc, JSON_C);
            var self = { serverInstance: { _cacheIsEnabled: 'true' }, throwError: noThrow };
            return function (req) { return fn({}, self, 'demo', { path: tmpRoot, ttl: 60 }, '<p>x</p>', req, res()); };
        },
        'render-json': function (cap) {
            var fn = new Function('lib', 'renderCache', 'JSON', extract(SRC.json) + '\nreturn writeCache;')(LIB, cap.rc, JSON_C);
            return function (req) { return fn('demo', { path: tmpRoot, ttl: 60 }, '{"x":1}', req, res(), 'true', noThrow); };
        }
    };
    var KIND = { 'render-swig': 'static', 'render-nunjucks': 'static', 'render-json': 'data' };

    // A request as an engine leaves it: the slots, the negotiated culture, the stamp.
    function req(culture, host, extra) {
        var r = Object.assign({
            routing          : { cache: { type: 'memory', ttl: 60 } },
            originalUrl      : '/page',
            headers          : {},
            _ginaIsProxyHost : !!host,
            culture          : culture
        }, extra || {});
        if (host) { r._ginaProxyHostname = host; }
        if (RenderCache.buildVariant) {
            r._ginaCacheVariant = RenderCache.buildVariant({ host: host || '', prefix: '', culture: culture });
        }
        return r;
    }

    Object.keys(WRITERS).forEach(function (name) {
        describe(name, function () {

            it('two cultures of one URL are stored under two keys', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                await write(req('fr', HOST_A));
                await write(req('en', HOST_A));
                assert.equal(cap.writes.length, 2);
                assert.notEqual(cap.writes[0].key, cap.writes[1].key, 'one key per culture');
            });

            it('two hosts of one URL are stored under two keys', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                await write(req('fr', HOST_A));
                await write(req('fr', HOST_B));
                assert.equal(cap.writes.length, 2);
                assert.notEqual(cap.writes[0].key, cap.writes[1].key, 'one key per host');
            });

            it('the key is buildKey over the stamp, and the readable variant rides the entry', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                var r = req('fr', HOST_A);
                await write(r);
                assert.equal(cap.writes.length, 1);
                assert.equal(cap.writes[0].key, KIND[name] + ':demo:' + (r._ginaCacheVariant && r._ginaCacheVariant.segment) + ':/page');
                assert.equal(cap.writes[0].entry.variant, r._ginaCacheVariant && r._ginaCacheVariant.readable);
            });

            it('a page whose culture is not the stamp\'s (a URL prefix, a middleware) is not stored', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                var r = req('en', HOST_A);
                r.culture = 'fr';
                await write(r);
                assert.equal(cap.writes.length, 0);
            });

            it('a request without a stamp is not stored', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                var r = req('fr', HOST_A);
                delete r._ginaCacheVariant;
                await write(r);
                assert.equal(cap.writes.length, 0);
            });

            it('CONTROL: a route without `cache` stores nothing', async function () {
                var cap = capture(), write = WRITERS[name](cap);
                await write(req('fr', HOST_A, { routing: {} }));
                assert.equal(cap.writes.length, 0);
            });
        });
    });

    it('each writer asks storableVariant before building its key', function () {
        [['render-swig', SRC.swig, 'lib.'], ['render-nunjucks', SRC.njk, 'libRef.'], ['render-json', SRC.json, 'lib.']]
            .forEach(function (row) {
                var body = extract(row[1]);
                var askAt = body.indexOf(row[2] + 'RenderCache.storableVariant(req)');
                var keyAt = body.indexOf('renderCache.buildKey(');
                assert.ok(askAt > -1, row[0] + ': asks storableVariant');
                assert.ok(askAt < keyAt, row[0] + ': before the key is built');
                assert.match(body, /renderCache\.buildKey\(\s*'(static|data)'\s*,\s*bundle\s*,\s*req\.originalUrl\s*,\s*cacheVariant\s*\)/, row[0] + ': keyed on the variant');
            });
    });
});


describe('§06 the engines — one stamp per request, read by every site', function () {

    it('isaac stamps the variant after the proxy slots, before its pre-routing read', function () {
        var prefixAt = SRC.isaac.indexOf('request._ginaProxyPrefix = _xfp;');
        var stampAt  = SRC.isaac.indexOf('request._ginaCacheVariant = server._renderCacheVariant(request, options.bundle);');
        var readAt   = SRC.isaac.indexOf('// Importing cache handler (render/output cache goes through the strategy dispatcher)');
        assert.ok(prefixAt > -1 && stampAt > -1 && readAt > -1, 'the three anchors');
        assert.ok(prefixAt < stampAt && stampAt < readAt, 'slots → stamp → read');
        var guard = SRC.isaac.slice(SRC.isaac.lastIndexOf('if (', stampAt), stampAt);
        assert.match(guard, /String\(server\._cacheIsEnabled\)\.toLowerCase\(\)\s*===\s*'true'/, 'stamped only while the cache is enabled');
    });

    it('isaac\'s read keys on the stamp, and looks nothing up without one', function () {
        var block = between(SRC.isaac, '// Importing cache handler (render/output cache goes through the strategy dispatcher)', 'if ( hasCachedKey ) {');
        assert.match(block, /var\s+cacheVariant\s*=\s*request\._ginaCacheVariant\s*\|\|\s*null\s*;/);
        assert.match(block, /pLen\s*=\s*\(\s*cacheVariant\s*\?\s*cacheKinds\.length\s*:\s*0\s*\)/);
        assert.match(block, /renderCache\.buildKey\(\s*cacheKinds\[p\]\s*,\s*options\.bundle\s*,\s*request\.url\s*,\s*cacheVariant\s*\)/);
    });

    it('server.js stamps a slot-less request first in the shared read, before any of its gates', function () {
        var block   = between(SRC.server, 'var tryServeRenderCacheHit', '// #M12b');
        var stampAt = block.indexOf('req._ginaCacheVariant = self.instance._renderCacheVariant(req, bundle);');
        var gateAt  = block.indexOf('var _method');
        assert.ok(stampAt > -1 && gateAt > stampAt, 'stamp → the first gate');
        var guard = block.slice(block.lastIndexOf('if (', stampAt), stampAt);
        assert.match(guard, /typeof\(req\._ginaCacheVariant\)\s*==\s*'undefined'/, 'an isaac stamp is never recomputed');
        assert.match(guard, /String\(self\.instance\._cacheIsEnabled\)\.toLowerCase\(\)\s*===\s*'true'/, 'only while the cache is enabled');
        var matchedAt = SRC.server.indexOf('if (matched) {');
        assert.ok(matchedAt > -1 && SRC.server.indexOf('if ( await tryServeRenderCacheHit(req, res, bundle) ) {', matchedAt) > matchedAt,
            'CONTROL: the shared read is called on every matched request, before dispatch');
    });

    it('the shared read keys on the stamp, and reads nothing without one', function () {
        var block = between(SRC.server, 'var tryServeRenderCacheHit', '// #M12b');
        assert.match(block, /var\s+_variant\s*=\s*req\._ginaCacheVariant\s*\|\|\s*null\s*;\s*if\s*\(\s*!_variant\s*\)\s*\{\s*return false;\s*\}/);
        assert.equal((block.match(/renderCache\.buildKey\(\s*_kinds\[i\]\s*,\s*bundle\s*,\s*_url\s*,\s*_variant\s*\)/g) || []).length, 2, 'the L1 probe and the L2 warm');
    });

    it('start() stamps the one variant function both engines call', function () {
        var block = between(SRC.server, 'instance._renderCacheVariant = function(req, bundle) {', '};');
        assert.ok(block, 'the stamp exists');
        assert.match(block, /resolveCultureNegotiation\(/);
        assert.match(block, /lib\.RenderCache\.variantFor\(\s*req\s*,/);
        assert.match(block, /negotiate\s*:\s*lib\.i18n\.negotiateCulture\b/);
    });

    it('_negotiateReqCulture reads the same culture options', function () {
        var helper = between(SRC.server, 'var _negotiateReqCulture', '// Checking cached route');
        assert.match(helper, /lib\.i18n\.negotiateCulture\(\s*req\s*,\s*resolveCultureNegotiation\(\s*routeBundle\s*\)\s*\)/);
    });

    describe('resolveCultureNegotiation, extracted and driven', function () {
        var resolve = null;
        before(function () {
            var src = between(SRC.server, 'var resolveCultureNegotiation = function', '\n    };\n');
            if (src) {
                resolve = function (self, catalogs, bundle) {
                    var gina = { _i18nCatalogs: catalogs };
                    return new Function('self', 'process', src + '\n    };\nreturn resolveCultureNegotiation;')(self, { gina: gina })(bundle);
                };
            }
        });
        function conf(settings) { return { env: 'prod', conf: { b: { prod: { content: { settings: settings } } } } }; }

        it('derives the cultures from the loaded catalogs, the cookie name and the default', function () {
            assert.ok(resolve, 'extractable');
            var o = resolve(conf({ region: { culture: 'fr_FR' } }), { b: { en: {}, fr: {} } }, 'b');
            assert.deepEqual(o.availableCultures, ['en', 'fr']);
            assert.equal(o.cookieName, 'gina_culture');
            assert.equal(o.defaultCulture, 'fr_FR');
        });

        it('honours settings.i18n.cultures (an intersection) and cookieName (null disables)', function () {
            assert.ok(resolve, 'extractable');
            var o = resolve(conf({ i18n: { cultures: ['fr'], cookieName: null } }), { b: { en: {}, fr: {} } }, 'b');
            assert.deepEqual(o.availableCultures, ['fr']);
            assert.strictEqual(o.cookieName, null);
            assert.strictEqual(o.defaultCulture, null);
        });

        it('a bundle without catalogs or settings: no cultures, the historical cookie name', function () {
            assert.ok(resolve, 'extractable');
            var o = resolve({ env: 'prod', conf: {} }, {}, 'none');
            assert.deepEqual(o.availableCultures, []);
            assert.equal(o.cookieName, 'gina_culture');
            assert.strictEqual(o.defaultCulture, null);
        });
    });
});


describe('§07 redis — the L2 key carries the variant; a warm restores the readable variant', function () {
    var V = RenderCache.buildVariant ? RenderCache.buildVariant({ host: HOST_A, prefix: '', culture: 'fr' }) : { segment: '', readable: '' };

    it('set(redis) writes L2 under the variant key, with the readable variant in the value', async function (t) {
        t.mock.timers.enable(['setTimeout']);
        var calls = [];
        var l2 = { set: function (k, v) { calls.push({ k: k, v: v }); return Promise.resolve(); }, warmRead: function () { return Promise.resolve(null); }, del: function () { return Promise.resolve(); } };
        var rc = new RenderCache({ l2: l2 });
        rc.from(new Map());
        var key = rc.buildKey('static', 'demo', '/r', V);
        await rc.set('redis', key, { ttl: 60, variant: V.readable }, { content: '<p>r</p>' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].k, key);
        assert.ok(calls[0].k.indexOf(':' + V.segment + ':') > 0, 'the L2 key holds the segment');
        assert.equal(JSON.parse(calls[0].v).variant, V.readable);
        rc.clear();
    });

    it('warm() restores the readable variant on the L1 entry', async function (t) {
        t.mock.timers.enable(['setTimeout']);
        var value = JSON.stringify({ content: 'w', responseHeaders: {}, visibility: 'private', variant: V.readable });
        var l2 = { set: function () { return Promise.resolve(); }, warmRead: function () { return Promise.resolve({ value: value, ttlMs: 30000 }); }, del: function () { return Promise.resolve(); } };
        var rc = new RenderCache({ l2: l2 });
        rc.from(new Map());
        var entry = await rc.warm(rc.buildKey('static', 'demo', '/w', V));
        assert.equal(entry.variant, V.readable);
        rc.clear();
    });
});


describe('§08 the merged-mode direct-host render is marked for the writers', function () {

    it('setOptions marks the request where it takes the hostname from another bundle\'s config', function () {
        var at    = SRC.ctrl.indexOf('if (isSpecialCase) {');
        var block = between(SRC.ctrl, 'if (isSpecialCase) {', '}');
        assert.ok(at > -1, 'the special case is still computed');
        assert.match(block, /hostname\s*=\s*_config\.hostname\s*;/, 'CONTROL: the branch still swaps the hostname');
        assert.match(block, /local\.req\._ginaHostSpecialCase\s*=\s*true\s*;/);
    });
});
