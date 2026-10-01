'use strict';
/**
 * #B212 — /_gina/assets/routing.json engine parity.
 *
 * The client-served routing maps (the full map + the #B66 host-stripped
 * variant) used to be built AND served by the isaac engine only
 * (`server.isaac.js`): under `engine: "express"` the URL fell through to
 * normal routing and 404'd — and the client, lacking a `response.ok` check
 * (#B213), then installed the 404 JSON body AS its routing table. Measured
 * live 2026-08-02 (isolated bundle, engine key the single variable, positive
 * controls `/web/` + `/_gina/health/check` + `/_gina/info` all 200 under
 * express, negative control 404 under both engines).
 *
 * The fix moves the map build into ONE engine-agnostic builder in
 * `core/server.js` (`buildClientRoutingAssets`) — isaac consumes it for its
 * precompressed-file fast-path, and a `server.js` `onRequest` handler serves
 * the maps from memory for every other engine, mirroring the MS2
 * `/_gina/health/check` precedent (same `/_gina/*` sync-rule gap, same fix
 * shape).
 *
 * Strategy: source inspection + behavioural extraction (the extracted REAL
 * builder is driven over synthetic route tables — no re-typed replica).
 * No live HTTP server or project required.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW           = require('../fw');
var SERVER_PATH  = path.join(FW, 'core/server.js');
var ISAAC_PATH   = path.join(FW, 'core/server.isaac.js');


describe('#B212 §00 — instrument: sources readable, known anchors present', function() {

    it('both engine sources read, and a known-positive anchor fires in each', function() {
        var serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
        var isaacSrc  = fs.readFileSync(ISAAC_PATH, 'utf8');
        // known positives — if these fail, later 0-results mean a broken
        // instrument, not an absent feature (pair every 0 with a firing control)
        assert.ok(serverSrc.indexOf('/_gina/health/check') > -1,
            'server.js health/check anchor must fire (control)');
        assert.ok(isaacSrc.indexOf('assetsCollection') > -1,
            'isaac assetsCollection anchor must fire (control)');
        // known negative — the instrument can also NOT fire
        assert.equal(serverSrc.indexOf('zzz-bogus-anchor-b212'), -1,
            'bogus anchor must not fire (control)');
    });
});


describe('#B212 §01 — the shared builder lives in core/server.js, and isaac consumes it', function() {

    var serverSrc, isaacSrc;

    before(function() {
        serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
        isaacSrc  = fs.readFileSync(ISAAC_PATH, 'utf8');
    });

    it('server.js defines buildClientRoutingAssets', function() {
        assert.ok(serverSrc.indexOf('function buildClientRoutingAssets(') > -1,
            'expected the engine-agnostic builder function in core/server.js');
    });

    it('the builder is an ALLOWLIST — the roster is explicit, and the #B66 derivation clones the allowlisted full map', function() {
        // Slice 3 (#SPA1): the old denylist strip meant every FUTURE route key
        // shipped to the browser by default (schema/routing.json is
        // additionalProperties:true at both levels — exactly how csrfExempt,
        // param.dto and queryTimeout got there). The cut is now an allowlist.
        var fnIdx = serverSrc.indexOf('function buildClientRoutingAssets(');
        assert.ok(fnIdx > -1);
        var rosterIdx  = serverSrc.indexOf("['url', 'method', 'webroot', 'bundle', 'hostname', 'host', 'negotiate']", fnIdx);
        var derivedIdx = serverSrc.indexOf('var _routingStripped = JSON.clone(_routing);', fnIdx);
        var hostIdx    = serverSrc.indexOf('const { host, hostname, ...cleanStripped }', fnIdx);
        assert.ok(rosterIdx > fnIdx, 'the route-level allowlist roster must be explicit in the builder');
        assert.ok(derivedIdx > rosterIdx,
            'the #B66 stripped variant must be derived AFTER the allowlist cut (so it inherits it)');
        assert.ok(hostIdx > derivedIdx, 'the #B66 host/hostname drop must operate on the derived clone');
    });

    it('webroot is never destructured away (load-bearing for client toUrl — #B66)', function() {
        assert.ok(serverSrc.indexOf('const { host, hostname, webroot,') < 0,
            'webroot must NOT be dropped — the client toUrl path relies on route.webroot');
    });

    it('init builds the maps BEFORE the engine is constructed, and hands them to it', function() {
        var buildIdx  = serverSrc.indexOf('buildClientRoutingAssets(serverOpt.allRoutes)');
        var handIdx   = serverSrc.indexOf('serverOpt.clientRoutingAssets');
        var engineIdx = serverSrc.indexOf("Engine = require('./server.'");
        assert.ok(buildIdx > -1, 'init must call the builder');
        assert.ok(handIdx > -1,  'init must hand the maps to the engine via serverOpt.clientRoutingAssets');
        assert.ok(engineIdx > -1, 'engine construction anchor (control)');
        assert.ok(buildIdx < engineIdx,
            'the maps must exist before `new Engine(serverOpt)` — isaac consumes them in its constructor');
        assert.ok(handIdx < engineIdx,
            'the hand-off must precede engine construction');
    });

    it('server.js keeps pre-stringified copies for its own serve path', function() {
        var fullIdx     = serverSrc.indexOf('full     : JSON.stringify(_clientRoutingAssets.full)');
        var strippedIdx = serverSrc.indexOf('stripped : JSON.stringify(_clientRoutingAssets.stripped)');
        assert.ok(fullIdx > -1,     'expected the pre-stringified full map on self._clientRoutingAssets');
        assert.ok(strippedIdx > -1, 'expected the pre-stringified stripped map on self._clientRoutingAssets');
    });

    it('isaac CONSUMES options.clientRoutingAssets instead of rebuilding', function() {
        assert.ok(isaacSrc.indexOf('options.clientRoutingAssets.full') > -1,
            'isaac must take the full map from options');
        assert.ok(isaacSrc.indexOf('options.clientRoutingAssets.stripped') > -1,
            'isaac must take the stripped map from options');
    });

    it('the strip no longer exists in isaac — ONE builder, no drift surface', function() {
        // decisive red-first discriminator: on pre-#B212 bytes these lines DO
        // exist in isaac, so this test fails until the build genuinely moves
        assert.equal(isaacSrc.indexOf('const { requireAuth, roles, policy, ...cleanParam } = clean.param;'), -1,
            'the #COMPLY1 strip must not be duplicated in isaac');
        assert.equal(isaacSrc.indexOf('var _routingStripped = JSON.clone(_routing);'), -1,
            'the #B66 derivation must not be duplicated in isaac');
    });

    it('isaac keeps its file-write fast-path (the precompressed variants)', function() {
        assert.ok(isaacSrc.indexOf("targetFile  = 'routing.json';") > -1,
            'the full-map file write stays in isaac');
        assert.ok(isaacSrc.indexOf("targetFile  = 'routing.stripped.json';") > -1,
            'the stripped-map file write stays in isaac');
    });
});


describe('#B212 §02 — the engine-agnostic onRequest handler', function() {

    var serverSrc;
    // the handler's banner: its matcher was rewritten by #B717 and again by #P48, the banner was not
    var ROUTING_BANNER = '// ── /_gina/assets/routing.json — client routing map';

    before(function() {
        serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
    });

    it('defines a GET /_gina/assets/routing.json handler inside onInstance, after health/check', function() {
        var healthIdx  = serverSrc.indexOf('/_gina\\/health\\/check(?:\\?|$)');
        var handlerIdx = serverSrc.indexOf(ROUTING_BANNER);
        assert.ok(healthIdx > -1,  'health/check regex anchor (control)');
        assert.ok(handlerIdx > -1, 'routing.json handler banner not found in server.js');
        assert.equal(serverSrc.indexOf(ROUTING_BANNER, handlerIdx + 1), -1, 'the routing.json handler banner must be unique');
        assert.ok(handlerIdx > healthIdx,
            'the asset handler sits with its /_gina siblings, after the liveness probe');
        // #P48 — the handler matches the url's PATH only (a versioned fetch carries `?v=<token>`;
        // a page whose query string ends in the map's path is the page's — the #B712 rule)
        var matcherIdx = serverSrc.indexOf("/\\/_gina\\/assets\\/routing\\.json$/i.test(request.url.split('?')[0])", handlerIdx);
        var nextIdx    = serverSrc.indexOf('// ── /_gina/metrics', handlerIdx);
        assert.ok(matcherIdx > handlerIdx, 'the path-only matcher must follow the banner');
        assert.ok(nextIdx > matcherIdx, 'the path-only matcher must be this handler\'s, above the next handler\'s banner');
    });

    it('classifies proxied-ness per request with the #B65-twin heuristic (isaac stamp is unreachable here)', function() {
        var handlerIdx = serverSrc.indexOf(ROUTING_BANNER);
        assert.ok(handlerIdx > -1, 'routing.json handler banner (anchor)');
        var hostIdx    = serverSrc.indexOf("request.headers.host || request.headers[':authority']", handlerIdx);
        var xfhIdx     = serverSrc.indexOf("request.headers['x-forwarded-host']", handlerIdx);
        var optOutIdx  = serverSrc.indexOf('process.gina._proxyRequireForwarded !== true', handlerIdx);
        assert.ok(hostIdx > handlerIdx,   'the handler must read Host/:authority itself');
        assert.ok(xfhIdx > handlerIdx,    'the handler must honour X-Forwarded-Host');
        assert.ok(optOutIdx > handlerIdx, 'the #B152 opt-out must disable the port-less-Host heuristic here too');
    });

    it('serves the stripped variant to proxied clients, the full map otherwise (#B66)', function() {
        var handlerIdx  = serverSrc.indexOf(ROUTING_BANNER);
        assert.ok(handlerIdx > -1, 'routing.json handler banner (anchor)');
        var strippedIdx = serverSrc.indexOf('self._clientRoutingAssets.stripped', handlerIdx);
        var fullIdx     = serverSrc.indexOf('self._clientRoutingAssets.full', handlerIdx);
        assert.ok(strippedIdx > handlerIdx, 'proxied clients get the host-stripped variant');
        assert.ok(fullIdx > handlerIdx,     'raw clients keep the full map');
    });

    it('marks the proxied variant private and both variants revalidating (shared caches must not cross-serve; staleness window closed)', function() {
        var handlerIdx = serverSrc.indexOf(ROUTING_BANNER);
        assert.ok(handlerIdx > -1, 'routing.json handler banner (anchor)');
        var ccIdx      = serverSrc.indexOf("'private, no-cache' : 'public, no-cache'", handlerIdx);
        assert.ok(ccIdx > handlerIdx,
            'expected the #B66 private/public split with no-cache (ETag revalidation) in the handler');
    });

    it('serves an ETag per variant and answers If-None-Match with 304 (both engines)', function() {
        var isaacSrc   = fs.readFileSync(ISAAC_PATH, 'utf8');
        var handlerIdx = serverSrc.indexOf(ROUTING_BANNER);
        assert.ok(handlerIdx > -1, 'routing.json handler banner (anchor)');
        // server.js side
        var etagIdx = serverSrc.indexOf("response.setHeader('etag',", handlerIdx);
        var inmIdx  = serverSrc.indexOf("request.headers['if-none-match']", handlerIdx);
        var s304Idx = serverSrc.indexOf('response.statusCode = 304;', handlerIdx);
        assert.ok(etagIdx > handlerIdx, 'server.js handler must emit an ETag');
        assert.ok(inmIdx  > handlerIdx, 'server.js handler must read If-None-Match');
        assert.ok(s304Idx > handlerIdx, 'server.js handler must answer 304 on a match');
        // isaac fast-path side (the /_gina/* sync rule: both engines behave identically)
        var iAnchor  = isaacSrc.indexOf('\\_gina\\/assets\\/routing\\.json');
        assert.ok(iAnchor > -1, 'isaac handler anchor (control)');
        var iEtagIdx = isaacSrc.indexOf("response.setHeader('etag',", iAnchor);
        var iInmIdx  = isaacSrc.indexOf("request.headers['if-none-match']", iAnchor);
        var iCcIdx   = isaacSrc.indexOf("'private, no-cache' : 'public, no-cache'", iAnchor);
        assert.ok(iEtagIdx > iAnchor, 'isaac fast-path must emit the same ETag');
        assert.ok(iInmIdx  > iAnchor, 'isaac fast-path must honour If-None-Match');
        assert.ok(iCcIdx   > iAnchor, 'isaac fast-path must carry the same no-cache split');
    });
});


describe('#B212 §03 — extracted builder behaviour (the REAL function, no replica)', function() {

    var build;

    // Extracts the genuine buildClientRoutingAssets from core/server.js by
    // string anchors and compiles it with a JSON.clone shim — the shipped
    // bytes are what runs, so a source drift fails here, not in production.
    before(function() {
        var src   = fs.readFileSync(SERVER_PATH, 'utf8');
        var start = src.indexOf('function buildClientRoutingAssets(');
        assert.ok(start > -1, 'builder not found — extraction cannot proceed');
        var retNeedle = 'return { full: _routing, stripped: _routingStripped };';
        var retIdx    = src.indexOf(retNeedle, start);
        assert.ok(retIdx > start, 'builder return shape not found');
        var end  = src.indexOf('}', retIdx + retNeedle.length);
        assert.ok(end > retIdx, 'builder closing brace not found');
        var body = src.slice(start, end + 1);
        var JSONShim = Object.create(JSON);
        JSONShim.clone = function(o) { return JSON.parse(JSON.stringify(o)); };
        /* eslint-disable no-new-func */
        var factory = new Function('JSON', body + '\nreturn buildClientRoutingAssets;');
        /* eslint-enable no-new-func */
        build = factory(JSONShim);
    });

    function sampleRoutes() {
        return {
            'panel@web': {
                method            : 'GET',
                url               : '/web/admin/:section',
                webroot           : '/web/',
                host              : 'http://internal-host:3100',
                hostname          : 'http://internal-host:3100',
                bundle            : 'web',
                middleware        : ['x'],
                middlewareIgnored : ['y'],
                namespace         : 'content',
                scopes            : ['local'],
                csrfExempt        : true,
                cache             : { type: 'memory', ttl: 60 },
                _comment          : 'internal note',
                futureKey         : 'a key added after this slice',
                requirements      : {
                    section : '\\w+',
                    email   : 'validator::{ isEmail: true }'
                },
                param             : {
                    section     : '\\w+',
                    control     : 'panel',
                    file        : 'admin',
                    path        : '/x',
                    title       : 'internal title',
                    requireAuth : true,
                    roles       : ['admin'],
                    policy      : 'isOwner',
                    'public'    : true
                }
            },
            'bounce@web': {
                method : 'GET',
                url    : '/old',
                webroot: '/web/',
                bundle : 'web',
                param  : { control: 'redirect', path: '/web/new', code: 302, ignoreWebRoot: true }
            },
            'plain@web': { method: 'GET', url: '/plain' }
        };
    }

    it('ALLOWLIST — an unknown/future route key never ships (the structural fix)', function() {
        var maps  = build(sampleRoutes());
        var route = maps.full['panel@web'];
        assert.equal(typeof route.futureKey, 'undefined',
            'a key the allowlist does not name must stay server-side BY DEFAULT');
    });

    it('drops the internals: _comment, middleware(+Ignored), namespace, scopes, csrfExempt, cache and the authorization keys', function() {
        var maps  = build(sampleRoutes());
        var route = maps.full['panel@web'];
        assert.equal(typeof route._comment,          'undefined');
        assert.equal(typeof route.middleware,        'undefined');
        assert.equal(typeof route.middlewareIgnored, 'undefined');
        assert.equal(typeof route.namespace,         'undefined');
        assert.equal(typeof route.scopes,            'undefined');
        assert.equal(typeof route.csrfExempt,        'undefined');
        assert.equal(typeof route.cache,             'undefined');
        assert.equal(typeof route.param.requireAuth, 'undefined');
        assert.equal(typeof route.param.roles,       'undefined');
        assert.equal(typeof route.param.policy,      'undefined');
        assert.equal(typeof route.param.public,      'undefined');
    });

    it('param ships URL-placeholder bindings ONLY — the dispatch keys stay server-side', function() {
        var maps  = build(sampleRoutes());
        var route = maps.full['panel@web'];
        // ':section' is declared in the route url → its binding regex ships
        assert.equal(route.param.section, '\\w+',
            'a param entry named by a `:placeholder` in the url is a binding the client getRoute/toUrl read');
        // dispatch keys are server-side contracts
        assert.equal(typeof route.param.control, 'undefined');
        assert.equal(typeof route.param.file,    'undefined');
        assert.equal(typeof route.param.path,    'undefined');
        assert.equal(typeof route.param.title,   'undefined');
    });

    it('keeps the measured client contract: url, method, webroot, bundle, host(name), requirements regexes', function() {
        var maps  = build(sampleRoutes());
        var route = maps.full['panel@web'];
        assert.equal(route.url, '/web/admin/:section');
        assert.equal(route.method, 'GET');
        assert.equal(route.webroot, '/web/');
        assert.equal(route.bundle, 'web');
        // the FULL map keeps host/hostname — only the #B66 variant drops them
        assert.equal(route.host, 'http://internal-host:3100');
        assert.equal(route.hostname, 'http://internal-host:3100');
        // plain-regex requirements survive (client toUrl reads key presence)…
        assert.equal(route.requirements.section, '\\w+');
        // …while `validator::` bodies are server-side validation specs
        assert.equal(typeof route.requirements.email, 'undefined');
    });

    it('derives isRedirect for redirect routes — the one dispatch fact the client toUrl branches on', function() {
        var maps = build(sampleRoutes());
        assert.equal(maps.full['bounce@web'].isRedirect, true);
        assert.equal(typeof maps.full['bounce@web'].param.control, 'undefined');
        assert.equal(typeof maps.full['bounce@web'].param.code,    'undefined');
        assert.equal(typeof maps.full['bounce@web'].param.ignoreWebRoot, 'undefined');
        // a non-redirect route derives nothing
        assert.equal(typeof maps.full['panel@web'].isRedirect, 'undefined');
    });

    it('ships the negotiate capability flag (the nav substrate) when declared', function() {
        var routes = sampleRoutes();
        routes['panel@web'].negotiate = true;
        var maps = build(routes);
        assert.equal(maps.full['panel@web'].negotiate, true);
    });

    it('the stripped variant drops host + hostname and KEEPS webroot, inheriting the allowlist cut', function() {
        var maps  = build(sampleRoutes());
        var route = maps.stripped['panel@web'];
        assert.equal(typeof route.host,     'undefined');
        assert.equal(typeof route.hostname, 'undefined');
        assert.equal(route.webroot, '/web/', 'webroot is load-bearing for the client toUrl path');
        // inherited from the allowlisted full map (derived AFTER, so nothing can resurface)
        assert.equal(typeof route.param.requireAuth, 'undefined');
        assert.equal(typeof route.param.control,     'undefined');
        assert.equal(typeof route.middleware,        'undefined');
        assert.equal(typeof route.futureKey,         'undefined');
    });

    it('a param-less route flows through with its allowlisted keys only (guarded)', function() {
        var maps = build(sampleRoutes());
        assert.equal(maps.full['plain@web'].url, '/plain');
        assert.equal(typeof maps.full['plain@web'].param, 'undefined');
        assert.equal(maps.stripped['plain@web'].url, '/plain');
    });

    it('never mutates the live route table (the JSON.clone guarantee)', function() {
        var input    = sampleRoutes();
        var snapshot = JSON.parse(JSON.stringify(input));
        build(input);
        assert.deepEqual(input, snapshot,
            'the builder must operate on clones — the live config is not its to rewrite');
    });
});


describe('#B213 §04 — the client routing fetch refuses non-2xx bodies', function() {

    it('core.js guards the routing fetch on response.ok (a 404 body must never become the table)', function() {
        var coreSrc = fs.readFileSync(
            path.join(FW, 'core/asset/plugin/src/vendor/gina/core.js'), 'utf8');
        var fetchIdx = coreSrc.indexOf('await fetch(filenameOrUrl)');
        assert.ok(fetchIdx > -1, 'routing fetch anchor (control)');
        var okIdx = coreSrc.indexOf('response.ok', fetchIdx);
        var parseIdx = coreSrc.indexOf('JSON.parse(result)', fetchIdx);
        assert.ok(okIdx > -1, 'the fetch must check response.ok — fetch resolves on HTTP error statuses, and the framework 404 body is valid JSON');
        assert.ok(parseIdx > -1, 'parse anchor (control)');
        assert.ok(okIdx < parseIdx, 'the guard must run BEFORE the body is parsed and installed');
    });

    it('the guard reaches the built browser artifact (dist freshness)', function() {
        // Needle choice validated against the PRE-fix bundle: a bare `.ok`
        // already matched once there (a stuck-TRUE instrument), while this
        // string literal read 0 — Closure keeps string literals, so it
        // discriminates fresh-with-guard from stale in both directions.
        var distSrc = fs.readFileSync(
            path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js'), 'utf8');
        assert.ok(distSrc.indexOf('ROUTING] HTTP ') > -1,
            'expected the response.ok guard error literal in the shipped bundle — rebuild the dist');
    });
});
