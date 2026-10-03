/**
 * core/server.js — the render/output-cache redis L2 READ path (#RC4, design f).
 *
 * `handle()` gained an engine-agnostic read that runs AFTER route matching and
 * BEFORE both dispatch paths: `if ( await tryServeRenderCacheHit(req, res, bundle) )
 * return;`. It is tightly gated (GET + a route that opts into caching + resolving to
 * the redis strategy + the cache enabled + an L2 store wired) so an uncached GET pays
 * nothing. On a hit it serves the memory-shaped entry (redis L1/L2 entries are always
 * `fromMemory` — never an fs filename) via `serveRenderCacheHit`, mirroring
 * server.isaac.js's cache-hit serve + render-json's HTTP/2 respond.
 *
 * §01 pins the source structure (the module-scope instance, the two closures, the
 * read call site, every gate, the F3 `_rcType` parity, the F6 dead/committed guard,
 * the F8 log ttl). §02 is a behavioural replica of the exact tryServe→serve control
 * flow driven by a fake renderCache + fake req/res: L1 hit serves WITHOUT a warm, an
 * L1 miss warms L2 then serves, both kinds are probed, HTTP/2 vs HTTP/1.1 write shapes,
 * the B2/F6 dead-response abandon, and SUBTRACTs proving an uncached / non-redis /
 * disabled route pays nothing (no warm, no serve).
 *
 * #RC5 (Slice 5) additions covered here: the Cache-Status `detail` parameter names
 * the physical tier the bytes came from (RFC 9211 §2.8 — `detail=memory` for an L1
 * hit, `detail=redis` for a shared-L2 warm, the cross-replica cold-start on the
 * wire), a genuine both-tier miss stamps the RFC §2.2 miss form
 * (`gina-cache; fwd=uri-miss` — express's first miss signal), and every gate return
 * still emits NO Cache-Status at all.
 */

'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW         = require('../fw');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');


describe('01 - core/server.js — read-path source pins (#RC4)', function() {

    it('declares ONE module-scope RenderCache instance (gen-0, survives refreshCore)', function() {
        assert.match(SERVER_SRC, /var\s+renderCache\s*=\s*new\s+lib\.RenderCache\(\)\s*;/);
    });

    it('defines serveRenderCacheHit(req, res, hit, source) and tryServeRenderCacheHit(req, res, bundle)', function() {
        assert.match(SERVER_SRC, /var\s+serveRenderCacheHit\s*=\s*function\s*\(\s*req\s*,\s*res\s*,\s*hit\s*,\s*source\s*\)/);
        assert.match(SERVER_SRC, /var\s+tryServeRenderCacheHit\s*=\s*async\s+function\s*\(\s*req\s*,\s*res\s*,\s*bundle\s*\)/);
    });

    it('calls the read inside `if (matched)`, before both dispatch paths', function() {
        var matchedAt = SERVER_SRC.indexOf('if (matched) {');
        assert.ok(matchedAt > -1);
        var readAt = SERVER_SRC.indexOf('if ( await tryServeRenderCacheHit(req, res, bundle) ) {', matchedAt);
        assert.ok(readAt > matchedAt, 'read call is inside the matched branch');
        // …and BEFORE the express-middleware dispatch + router.route.
        var mwAt    = SERVER_SRC.indexOf("_expressMiddlewares.length > 0", matchedAt);
        var routeAt = SERVER_SRC.indexOf('router.route(req, res, next, req.routing)', matchedAt);
        assert.ok(readAt < mwAt,    'read runs before the express-middleware chain');
        assert.ok(readAt < routeAt, 'read runs before router.route');
    });

    // --- the tryServe gates (an uncached GET pays nothing) ---
    var tStart = SERVER_SRC.indexOf('var tryServeRenderCacheHit');
    var tEnd   = SERVER_SRC.indexOf('// #M12b', tStart); // the next function after tryServe/serve
    var tryBlock = SERVER_SRC.slice(tStart, tEnd > tStart ? tEnd : tStart + 4000);

    it('gates on GET method (isaac ":method" pseudo-header aware)', function() {
        assert.match(tryBlock, /if\s*\(\s*!\/\^get\$\/i\.test\(\s*_method\s*\|\|\s*req\.method\s*\|\|\s*''\s*\)\s*\)\s*\{\s*return false;/);
    });

    it('gates on a route that opts into caching (req.routing.cache)', function() {
        assert.match(tryBlock, /if\s*\(\s*!req\.routing\s*\|\|\s*!req\.routing\.cache\s*\)\s*\{\s*return false;/);
    });

    it('gates on the cache being enabled (_cacheIsEnabled === "true")', function() {
        assert.match(tryBlock, /String\(self\.instance\._cacheIsEnabled\)\.toLowerCase\(\)\s*!==\s*'true'/);
    });

    it('gates on an L2 store being wired (process.gina._renderCacheStore)', function() {
        assert.match(tryBlock, /if\s*\(\s*!\(\s*process\.gina\s*&&\s*process\.gina\._renderCacheStore\s*\)\s*\)\s*\{\s*return false;/);
    });

    it('F3: only inherits the bundle-wide type when the route OMITS type (typeof !== undefined)', function() {
        assert.match(tryBlock, /typeof\(_rc\.type\)\s*!==\s*'undefined'/);
        assert.match(tryBlock, /if\s*\(\s*!\/\^redis\$\/i\.test\(_rcType\s*\|\|\s*''\)\s*\)\s*\{\s*return false;/);
    });

    it('reads with req.originalUrl (delegate write-key parity) and probes both kinds', function() {
        assert.match(tryBlock, /var\s+_url\s*=\s*req\.originalUrl\s*\|\|\s*req\.url\s*;/);
        assert.match(tryBlock, /var\s+_kinds\s*=\s*\['data',\s*'static'\]/);
    });

    it('tries L1 (has/get) before an L2 warm(), and re-registers invalidateOnEvents on warm', function() {
        var l1At   = tryBlock.indexOf('renderCache.has(_k)');
        var warmAt = tryBlock.indexOf('await renderCache.warm(_k, _events)');
        assert.ok(l1At > -1 && warmAt > -1 && l1At < warmAt, 'L1 has() precedes the L2 warm()');
        assert.match(tryBlock, /var\s+_events\s*=[\s\S]{1,160}invalidateOnEvents/);
    });

    it('points the shared Map via from() before reading (one-Map, #B115-safe)', function() {
        assert.match(tryBlock, /renderCache\.from\(\s*self\.instance\._cached\s*\)\s*;/);
    });

    // --- serveRenderCacheHit shape (F6 guard, HTTP/2 vs 1.1, F8 log) ---
    var sStart = SERVER_SRC.indexOf('var serveRenderCacheHit');
    var sEnd   = SERVER_SRC.indexOf('var tryServeRenderCacheHit', sStart);
    var serveBlock = SERVER_SRC.slice(sStart, sEnd);

    it('F6: the B2 guard abandons on a gone OR already-committed response', function() {
        // HTTP/2 arm: destroyed || headersSent ; HTTP/1.1 arm: writableEnded || destroyed || headersSent
        assert.match(serveBlock, /res\.stream\.destroyed\s*\|\|\s*res\.stream\.headersSent/);
        assert.match(serveBlock, /res\.writableEnded\s*\|\|\s*res\.destroyed\s*\|\|\s*res\.headersSent/);
    });

    it('HTTP/2 folds res.getHeaders() into stream.respond({:status:200}) then end(re-nonced content)', function() {
        assert.match(serveBlock, /_sh\s*=\s*\{\s*':status':\s*200\s*\}/);
        assert.match(serveBlock, /res\.stream\.respond\(_sh\)/);
        // #B130 — both ends serve _hitContent (the re-nonced body when the stored
        // CSP header carries a nonce; the stored body verbatim otherwise).
        assert.match(serveBlock, /res\.stream\.end\(_hitContent\)/);
    });

    it('HTTP/1.1 serves via res.end(_hitContent) behind a headersSent guard', function() {
        assert.match(serveBlock, /if\s*\(\s*!res\.headersSent\s*&&\s*!res\.writableEnded\s*\)\s*\{\s*res\.end\(_hitContent\)/);
    });

    it('F8/#RC5: ONE header string — built once into _cs (ttl + detail), set AND logged from it', function() {
        // The single-var build kills the prior setHeader-vs-console.info dual construction.
        // #B238 — the identifier comes from the boot-resolved stamp, not a literal.
        assert.match(serveBlock, /var\s+_cs\s*=\s*self\.instance\._cacheName\s*\+\s*'; hit'[\s\S]{0,160}?';\s*ttl='\s*\+\s*_remaining[\s\S]{0,160}?';\s*detail='\s*\+\s*source/);
        assert.match(serveBlock, /res\.setHeader\('Cache-Status',\s*_cs\)/);
        assert.match(serveBlock, /\[200\]\['\s*\+\s*_cs\s*\+\s*'\]/);
    });

    it('#B238: the identifier is stamped ONCE at boot and the literals are globally gone', function() {
        // Stamp site: resolveCacheName over the post-fold server.cache, onto the
        // engine instance both engines read.
        assert.match(SERVER_SRC, /instance\._cacheName\s*=\s*lib\.RenderCache\.resolveCacheName\(\s*self\.conf\[self\.appName\]\[self\.env\]\.server\.cache\s*\)/);
        // Window-independent negatives (globally-zero code shapes — comments reference
        // the old value without the quoted-prefix form, per the jsdoc-mention rule):
        assert.ok(SERVER_SRC.indexOf("'gina-cache; hit'") < 0, 'the hit literal must not return');
        assert.ok(SERVER_SRC.indexOf("'gina-cache; fwd=uri-miss'") < 0, 'the miss literal must not return');
    });

    it('#RC5: threads the hit tier — memory from the L1 loop, redis from the warm loop', function() {
        var memAt   = tryBlock.indexOf("_hitSource = 'memory'");
        var redisAt = tryBlock.indexOf("_hitSource = 'redis'");
        assert.ok(memAt > -1 && redisAt > -1 && memAt < redisAt, 'both tiers threaded, the L1 loop first');
        assert.match(tryBlock, /serveRenderCacheHit\(req,\s*res,\s*_hit,\s*_hitSource\)/);
    });

    it('#RC5: a genuine both-tier miss emits the RFC 9211 form behind a headersSent guard', function() {
        // #B238 — the identifier is the boot-resolved stamp; the RFC form suffix is
        // unchanged. The ordering anchor moves to the suffix literal accordingly.
        var missAt = tryBlock.indexOf("'; fwd=uri-miss'");
        var warmAt = tryBlock.indexOf('await renderCache.warm');
        assert.ok(missAt > -1 && warmAt > -1 && missAt > warmAt,
            'the miss emission sits AFTER the L2 warm attempt — never on a gate return');
        assert.match(tryBlock, /if\s*\(\s*!res\.headersSent\s*\)\s*\{[\s\S]{0,220}?res\.setHeader\('Cache-Status',\s*self\.instance\._cacheName\s*\+\s*'; fwd=uri-miss'\)/);
    });

    it('#RC5: tryServe carries exactly ONE setHeader — the miss stamp (gate returns emit nothing)', function() {
        assert.equal((tryBlock.match(/res\.setHeader\(/g) || []).length, 1,
            'any new setHeader on a gate return would falsely brand an unconsulted request');
    });
});


describe('02 - read-path control flow — behavioural replica + subtract (#RC4)', function() {

    // A fake renderCache mirroring the real seam the read path uses: from / buildKey /
    // has / get / warm. Records warm() calls so a test can assert an L1 hit serves
    // WITHOUT touching L2.
    function fakeRC(l1, l2) {
        var calls = { warm: [], from: 0 };
        return {
            calls: calls,
            from: function() { calls.from++; return this; },
            buildKey: function(kind, bundle, url) { return kind + ':' + bundle + ':' + url; },
            has: function(k) { return Object.prototype.hasOwnProperty.call(l1, k); },
            get: function(k) { return l1[k]; },
            warm: async function(k, events) {
                calls.warm.push({ key: k, events: events });
                return (k in l2) ? l2[k] : undefined;
            }
        };
    }

    // A fake response for HTTP/1.1 or HTTP/2 that records the write.
    function fakeRes(isH2) {
        var res = {
            headers: {}, headersSent: false, writableEnded: false, destroyed: false,
            body: null,
            setHeader: function(k, v) { this.headers[k] = v; },
            getHeaders: function() { return this.headers; }
        };
        if (isH2) {
            res.stream = { headersSent: false, destroyed: false, respondHeaders: null, body: null,
                respond: function(h) { this.respondHeaders = h; this.headersSent = true; },
                end: function(c) { this.body = c; } };
        } else {
            res.end = function(c) { this.body = c; this.writableEnded = true; this.headersSent = true; };
        }
        return res;
    }

    // Faithful replica of the real handle()-scope tryServe + serve, parameterised by
    // engine + config. Mirrors the source control flow line-for-line.
    function makeReader(opts) {
        var protocol     = opts.protocol || 'http/1.1';
        var cacheEnabled = ('cacheEnabled' in opts) ? opts.cacheEnabled : 'true';
        var store        = ('store' in opts) ? opts.store : {};   // truthy = wired
        var serverCache  = opts.serverCache || {};
        var rc           = opts.rc;
        // #B238 — models the boot-resolved `instance._cacheName` stamp (resolveCacheName
        // over server.cache: configured name when valid, else the default). The real
        // read sites consume the stamp unguarded; the `|| 'gina-cache'` here compresses
        // resolve→stamp→read into the replica's one seam.
        var cacheName    = opts.cacheName || 'gina-cache';

        function serve(req, res, hit, source) {
            var _isH2 = /http\/2/.test(protocol) && res.stream;
            if ( _isH2
                    ? ( res.stream.destroyed || res.stream.headersSent )
                    : ( res.writableEnded || res.destroyed || res.headersSent ) ) {
                return true;
            }
            var _remaining = null;
            if ( typeof(hit.ttl) === 'number' && hit.ttl > 0 && hit.createdAt ) {
                _remaining = Math.max(0, Math.floor( (hit.createdAt.getTime() + Math.round(hit.ttl * 1000) - Date.now()) / 1000 ));
            }
            var _vis = ( hit.visibility === 'public' ) ? 'public' : 'private';
            if ( hit.responseHeaders ) {
                for (var h in hit.responseHeaders) { res.setHeader(h, hit.responseHeaders[h]); }
            }
            var _cs = cacheName + '; hit'
                + (_remaining !== null ? '; ttl=' + _remaining : '')
                + (source ? '; detail=' + source : '');
            res.setHeader('Cache-Status', _cs);
            if ( _remaining !== null ) { res.setHeader('Cache-Control', _vis + ', max-age=' + _remaining); }
            if ( _isH2 ) {
                if ( !res.stream.headersSent && !res.stream.destroyed ) {
                    var _sh = { ':status': 200 };
                    var _pending = res.getHeaders ? res.getHeaders() : {};
                    for (var ph in _pending) { _sh[ph] = _pending[ph]; }
                    res.stream.respond(_sh);
                    res.stream.end(hit.content);
                    // was: res.headersSent = true; — removed from core/server.js by #B750 (getter-only on the real response)
                }
            } else {
                if ( !res.headersSent && !res.writableEnded ) { res.end(hit.content); }
            }
            return true;
        }

        return async function tryServe(req, res, bundle) {
            var _method = ( /http\/2/.test(protocol) ) ? req.headers[':method'] : req.method;
            if ( !/^get$/i.test(_method || req.method || '') ) { return false; }
            if ( !req.routing || !req.routing.cache ) { return false; }
            if ( String(cacheEnabled).toLowerCase() !== 'true' ) { return false; }
            if ( !store ) { return false; }

            var _rc = req.routing.cache;
            var _rcType;
            if ( typeof(_rc) === 'string' ) { _rcType = _rc; }
            else if ( _rc && typeof(_rc.type) !== 'undefined' ) { _rcType = _rc.type; }
            else { _rcType = serverCache && serverCache.type; }
            if ( !/^redis$/i.test(_rcType || '') ) { return false; }

            var _events = ( _rc && typeof(_rc) === 'object' && Array.isArray(_rc.invalidateOnEvents) ) ? _rc.invalidateOnEvents : [];
            var _url    = req.originalUrl || req.url;
            rc.from({});

            var _kinds = ['data', 'static'], _hit = null, _hitSource = null, i, _k;
            for (i = 0; i < _kinds.length; i++) {
                _k = rc.buildKey(_kinds[i], bundle, _url);
                if ( rc.has(_k) ) { _hit = rc.get(_k); if ( _hit ) { _hitSource = 'memory'; break; } _hit = null; }
            }
            if ( !_hit ) {
                for (i = 0; i < _kinds.length; i++) {
                    _k = rc.buildKey(_kinds[i], bundle, _url);
                    _hit = await rc.warm(_k, _events); if ( _hit ) { _hitSource = 'redis'; break; } _hit = null;
                }
            }
            if ( !_hit ) {
                if ( !res.headersSent ) {
                    res.setHeader('Cache-Status', cacheName + '; fwd=uri-miss');
                }
                return false;
            }
            return serve(req, res, _hit, _hitSource);
        };
    }

    function redisReq(extra) {
        return Object.assign({ method: 'GET', headers: {}, routing: { cache: { type: 'redis', invalidateOnEvents: ['post#saved'] } },
                               originalUrl: '/p', url: '/p' }, extra || {});
    }

    it('L1 hit serves WITHOUT a warm (express fast path)', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'L1', visibility: 'public' } }, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true);
        assert.equal(res.body, 'L1');
        assert.equal(rc.calls.warm.length, 0, 'an L1 hit never touches L2');
        assert.equal(res.headers['Cache-Status'], 'gina-cache; hit; detail=memory',
            '#RC5: an L1 hit is labelled detail=memory (RFC 9211 §2.8)');
    });

    it('L1 miss → warm() L2 → serve, re-registering the route events', async function() {
        var rc = fakeRC({}, { 'data:demo:/p': { fromMemory: true, content: 'L2', visibility: 'private' } });
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true);
        assert.equal(res.body, 'L2');
        assert.equal(rc.calls.warm.length, 1, 'one warm (data hit — the first kind)');
        assert.deepEqual(rc.calls.warm[0].events, ['post#saved'], 'invalidateOnEvents threaded to warm');
        assert.equal(res.headers['Cache-Status'], 'gina-cache; hit; detail=redis',
            '#RC5: a shared-L2 warm is labelled detail=redis — the cross-replica cold-start on the wire');
    });

    it('#RC5: a genuine both-tier miss returns false AND stamps the RFC miss form', async function() {
        var rc = fakeRC({}, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, false, 'miss → fall through to the render');
        assert.equal(res.headers['Cache-Status'], 'gina-cache; fwd=uri-miss',
            'RFC 9211 §2.2 — uri-miss is a VALUE of fwd, never a bare parameter');
        assert.equal(rc.calls.warm.length, 2, 'both kinds probed before the miss verdict');
    });

    it('#RC5: the miss stamp is skipped on an already-committed response (headersSent guard)', async function() {
        var rc = fakeRC({}, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        res.headersSent = true;
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, false);
        assert.equal(res.headers['Cache-Status'], undefined, 'no setHeader after headersSent');
    });

    it('#B238: a configured cache.name is the ONLY byte that moves — hit and miss, params identical', async function() {
        // Hit arm
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'L1', visibility: 'public' } }, {});
        var tryServe = makeReader({ rc: rc, cacheName: 'cache' });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true);
        assert.equal(res.headers['Cache-Status'], 'cache; hit; detail=memory',
            'identifier swapped, params byte-identical to the default wire');
        // Miss arm
        var rc2 = fakeRC({}, {});
        var tryServe2 = makeReader({ rc: rc2, cacheName: 'cache' });
        var res2 = fakeRes(false);
        var served2 = await tryServe2(redisReq(), res2, 'demo');
        assert.equal(served2, false);
        assert.equal(res2.headers['Cache-Status'], 'cache; fwd=uri-miss',
            'the miss form carries the same configured identifier');
    });

    it('probes BOTH kinds on a data-miss/static-hit', async function() {
        var rc = fakeRC({}, { 'static:demo:/p': { fromMemory: true, content: 'S', visibility: 'public' } });
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        await tryServe(redisReq(), res, 'demo');
        assert.equal(res.body, 'S');
        assert.equal(rc.calls.warm.length, 2, 'data warm (miss) then static warm (hit)');
        assert.equal(rc.calls.warm[0].key, 'data:demo:/p');
        assert.equal(rc.calls.warm[1].key, 'static:demo:/p');
    });

    it('HTTP/2 serves via stream.respond({:status:200}) + end(content), folding headers', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'H2', visibility: 'public', responseHeaders: { 'x-a': '1' } } }, {});
        var tryServe = makeReader({ protocol: 'http/2', rc: rc });
        var res = fakeRes(true);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true);
        assert.equal(res.stream.body, 'H2');
        assert.equal(res.stream.respondHeaders[':status'], 200);
        assert.equal(res.stream.respondHeaders['x-a'], '1', 'page header folded into the respond');
        assert.equal(res.stream.respondHeaders['Cache-Status'], 'gina-cache; hit; detail=memory');
    });

    it('ttl entry → Cache-Status + Cache-Control carry the remaining ttl (detail last)', async function() {
        var hit = { fromMemory: true, content: 'T', visibility: 'public', ttl: 60, createdAt: new Date(Date.now() - 10000) };
        var rc = fakeRC({ 'static:demo:/p': hit }, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        await tryServe(redisReq(), res, 'demo');
        assert.match(res.headers['Cache-Status'], /^gina-cache; hit; ttl=\d+; detail=memory$/,
            'param order: hit, ttl, then detail — the shipped `gina-cache; hit` prefix stays grep-stable');
        assert.match(res.headers['Cache-Control'], /public, max-age=\d+/);
    });

    it('F6/B2: a destroyed HTTP/1.1 response is abandoned (return true, no write)', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'X', visibility: 'public' } }, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        res.destroyed = true;             // client aborted during the warm await
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true, 'abandoned = handled (never fall through to a render)');
        assert.equal(res.body, null, 'no write to a dead socket');
    });

    it('F6: an already-committed (headersSent) response is abandoned before the setHeader loop', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'X', visibility: 'public', responseHeaders: { 'x': '1' } } }, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        res.headersSent = true;
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, true);
        assert.equal(res.headers['x'], undefined, 'no setHeader after headersSent (no ERR_HTTP_HEADERS_SENT)');
    });

    // --- SUBTRACTs: the gates make an uncached / non-redis / disabled GET pay nothing ---
    // #RC5: each also asserts NO Cache-Status is stamped — the miss form marks
    // "consulted and missed", never "not consulted".
    it('SUBTRACT — a non-redis (memory) route pays nothing (no warm, false)', async function() {
        var rc = fakeRC({}, { 'static:demo:/p': { fromMemory: true, content: 'M' } });
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var req = redisReq({ routing: { cache: { type: 'memory' } } });
        var served = await tryServe(req, res, 'demo');
        assert.equal(served, false);
        assert.equal(rc.calls.warm.length, 0, 'a memory route never reaches the L2 read');
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('SUBTRACT — a route with no cache pays nothing', async function() {
        var rc = fakeRC({}, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var served = await tryServe(redisReq({ routing: {} }), res, 'demo');
        assert.equal(served, false);
        assert.equal(rc.calls.from, 0, 'never even points the Map for an uncached route');
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('SUBTRACT — a non-GET (POST) redis route pays nothing', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'X' } }, {});
        var tryServe = makeReader({ rc: rc });
        var res = fakeRes(false);
        var served = await tryServe(redisReq({ method: 'POST' }), res, 'demo');
        assert.equal(served, false);
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('SUBTRACT — the cache disabled pays nothing (even a redis route)', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'X' } }, {});
        var tryServe = makeReader({ rc: rc, cacheEnabled: 'false' });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, false);
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('SUBTRACT — no L2 store wired pays nothing', async function() {
        var rc = fakeRC({}, {});
        var tryServe = makeReader({ rc: rc, store: null });
        var res = fakeRes(false);
        var served = await tryServe(redisReq(), res, 'demo');
        assert.equal(served, false);
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('F3: a route type:"" (set-but-blank) does NOT inherit a bundle redis default', async function() {
        var rc = fakeRC({ 'static:demo:/p': { fromMemory: true, content: 'X' } }, {});
        var tryServe = makeReader({ rc: rc, serverCache: { type: 'redis' } });
        var req = redisReq({ routing: { cache: { type: '' } } });
        var res = fakeRes(false);
        var served = await tryServe(req, res, 'demo');
        assert.equal(served, false, 'blank route type is not-cached (writeCache parity), not inherited-redis');
        assert.equal(rc.calls.warm.length, 0);
        assert.equal(res.headers['Cache-Status'], undefined, 'a gate return emits NO Cache-Status');
    });

    it('a type-less opt-in route inherits the bundle redis default (warms)', async function() {
        var rc = fakeRC({}, { 'data:demo:/p': { fromMemory: true, content: 'INH', visibility: 'private' } });
        var tryServe = makeReader({ rc: rc, serverCache: { type: 'redis' } });
        var req = redisReq({ routing: { cache: {} } });   // opts in, no type → inherit
        var served = await tryServe(req, fakeRes(false), 'demo');
        assert.equal(served, true);
        assert.equal(rc.calls.warm.length, 1);
    });
});


describe('03 - /_gina/cache/stats — L2 health fold (#RC5)', function() {

    it('folds store.health() into the payload as `l2`, guarded on the function existing', function() {
        assert.match(SERVER_SRC, /_cacheStatsPayload\.l2\s*=\s*process\.gina\._renderCacheStore\.health\(\)/);
        assert.match(SERVER_SRC, /typeof\(process\.gina\._renderCacheStore\.health\)\s*===\s*'function'/);
    });

    it('the fold sits AFTER the admin gate (a denied client never reaches it)', function() {
        var gateAt = SERVER_SRC.indexOf('/_gina/cache/stats: client IP not in app.json admin.allowFrom');
        var foldAt = SERVER_SRC.indexOf('_cacheStatsPayload.l2 =');
        assert.ok(gateAt > -1 && foldAt > gateAt, 'the 403 gate precedes the l2 fold');
    });

    // Faithful replica of the fold gate (both engines share the semantics —
    // server.isaac.js §17 pins its own copy at the source level).
    function foldL2(payload, store) {
        if ( store && typeof(store.health) === 'function' ) {
            payload.l2 = store.health();
        }
        return payload;
    }

    it('no store wired → NO l2 field (memory/fs bundles unchanged)', function() {
        var p = foldL2({ size: 0, entries: [] }, null);
        assert.equal('l2' in p, false, 'the field is ADDITIVE — absent when no L2 store exists');
    });

    it('a store without health() (a future non-redis store) → NO l2 field, no throw', function() {
        var p = foldL2({ size: 0, entries: [] }, { set: function(){}, warmRead: function(){}, del: function(){} });
        assert.equal('l2' in p, false);
    });

    it('a store with health() → additive l2, size/entries untouched', function() {
        var h = { store: 'redis', status: 'ready', mode: 'standalone', prefix: 'cache:', errorCount: 0, lastError: null, lastErrorAt: null };
        var p = foldL2({ size: 2, entries: [{ key: 'k' }] }, { health: function() { return h; } });
        assert.deepEqual(p.l2, h);
        assert.equal(p.size, 2);
        assert.equal(p.entries.length, 1);
    });
});


describe('04 - #B130 hit-serve re-nonce (both engines, keep in sync)', function() {

    var ISAAC_SRC = fs.readFileSync(path.join(FW, 'core/server.isaac.js'), 'utf8');

    // ── server.js serveRenderCacheHit ──

    var sStart = SERVER_SRC.indexOf('var serveRenderCacheHit');
    var sEnd   = SERVER_SRC.indexOf('var tryServeRenderCacheHit', sStart);
    var serveBlock = SERVER_SRC.slice(sStart, sEnd);

    it('computes the re-nonce BEFORE the stored-header replay loop', function() {
        var rnAt   = serveBlock.indexOf('lib.RenderCache.renonceCspHeaders(hit.responseHeaders || null)');
        var loopAt = serveBlock.indexOf('for (var h in _hitHeaders)');
        assert.ok(rnAt > -1, 'expected the renonceCspHeaders call');
        assert.ok(loopAt > rnAt, 'the header replay loop must consume the re-nonced copy');
    });

    it('derives _hitContent via swapNonces and never mutates the stored entry', function() {
        assert.match(serveBlock, /_hitContent\s*=\s*_rn\s*\?\s*lib\.RenderCache\.swapNonces\(hit\.content,\s*_rn\.oldNonces,\s*_rn\.nonce\)\s*:\s*hit\.content/);
        // no assignment INTO the stored entry
        assert.doesNotMatch(serveBlock, /hit\.responseHeaders\s*=/);
        assert.doesNotMatch(serveBlock, /hit\.content\s*=/);
    });

    // ── isaac pre-routing read (the engine mirror) ──

    it('isaac mirrors the re-nonce at its pre-routing read (keep-in-sync pair)', function() {
        assert.ok(ISAAC_SRC.indexOf('lib.RenderCache.renonceCspHeaders(') > -1,
            'expected the isaac re-nonce call');
        assert.match(ISAAC_SRC, /_rnHeaders\s*=\s*_rn\s*\?\s*_rn\.headers\s*:\s*cachedContentObj\.responseHeaders/);
        assert.match(ISAAC_SRC, /lib\.RenderCache\.swapNonces\(cachedContentObj\.content,\s*_rn\.oldNonces,\s*_rn\.nonce\)/);
    });

    it('isaac fs read-back buffers ONLY when a re-nonce applies (stream path untouched otherwise)', function() {
        var isaacRnAt = ISAAC_SRC.indexOf('function onCachedFileRenonce');
        assert.ok(isaacRnAt > -1, 'expected the buffered fs re-nonce branch');
        // the buffered branch is gated on _rn, and the streaming path survives after it
        var gateAt   = ISAAC_SRC.lastIndexOf('if ( _rn ) {', isaacRnAt);
        var streamAt = ISAAC_SRC.indexOf('fs.createReadStream(filename)', isaacRnAt);
        assert.ok(gateAt > -1 && streamAt > isaacRnAt, 'gated buffer branch + surviving stream path');
    });

});
