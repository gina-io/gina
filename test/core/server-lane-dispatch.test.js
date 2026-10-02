'use strict';
/**
 * #P49 — the fast lane's wiring in core/server.js and core/gna.js.
 *
 * A route declaring `param.lane` is registered by a boot walk in `init()`, then
 * served by `lib.lane.dispatch()` instead of `router.route()`: on isaac as the
 * terminal of the bundle's middleware chain (so session and CSRF middleware
 * still run), on express directly (its app layers ran before gina's handler).
 * In dev mode core/gna.js watches the lane directories and sets a dirty flag
 * lib/lane reads before reloading.
 *
 *  §01 the boot walk — once, inside init() after the message-validator walk and
 *      before the authorization lint (so before the `configured` emit); the
 *      four options it passes; the debug line.
 *  §02 the branch in _handleDispatch — the lookup after the render-cache read
 *      and before the isaac chain; `'lane'` set after the untouched `'route'`
 *      line; the express dispatch before router.route; no shim call of its own;
 *      nothing of the lane after the server-level throwError.
 *  §03 the chain terminal — a `'lane'` branch beside `'route'` and the statics one.
 *  §04 the REAL bytes, run together on stubs: the _handleDispatch branch and
 *      createNextMiddleware — isaac with a middleware chain, isaac without one,
 *      express; lane and classic routes; a middleware error; a middleware
 *      replacing the request; the configuration of a merged bundle.
 *  §05 core/gna.js — the `lane` dirty flag, and the REAL watcher block run on a
 *      stub watcher: a `change` and a `rename` watch per directory, each
 *      setting the flag.
 *
 * Positions are read on the raw bytes, each anchor asserted to occur exactly
 * once (a regex comment-stripper lets a `/*` inside a string swallow code).
 *
 * Seams: `GINA_SERVER_SRC=<file>` / `GINA_GNA_SRC=<file>` read those files in
 * place of the tree's core/server.js / core/gna.js (red-first).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW      = require('../fw');
var RAW_SRV = fs.readFileSync(process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8');
var RAW_GNA = fs.readFileSync(process.env.GINA_GNA_SRC || path.join(FW, 'core/gna.js'), 'utf8');

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The position of a needle that occurs exactly once — so neither a copy nor a
 * comment quoting it can satisfy a position pin. (Positions are taken on the
 * raw bytes: stripping block comments with a regex lets a `/*` inside a string
 * swallow real code — measured, it loses the `configured` emit.)
 */
function once(src, needle) {
    assert.equal(count(src, needle), 1, 'exactly once: ' + needle);
    return src.indexOf(needle);
}
var SRV = RAW_SRV;
var GNA = RAW_GNA;

/**
 * The text of a brace-delimited block opened by the first `{` at or after
 * `from`, braces included.
 */
function blockFrom(src, from) {
    var i = src.indexOf('{', from), depth = 0, end = -1;
    assert.ok(i > -1, 'harness: an opening brace');
    for (; i < src.length; ++i) {
        if ( src[i] === '{' ) { depth++; }
        else if ( src[i] === '}' ) { depth--; if ( depth === 0 ) { end = i + 1; break; } }
    }
    assert.ok(end > from, 'harness: balanced braces');
    return src.substring(from, end);
}

var WALK_CALL   = 'lib.lane.registerRoutes(serverOpt.routing || {}, {';
var LANE_CONF   = 'var _laneConf  = self.conf[self.appName][self.env];';
var LOOKUP      = 'var _laneEntry = ( req.routing.param && req.routing.param.lane ) ? lib.lane.lookup(req.routing) : null;';
var CHAIN_IF    = 'if ( /^isaac/.test(self.engine) && self.instance._expressMiddlewares.length > 0) {';
var ACTION_RT   = "nextMiddleware._nextAction   = 'route';";
var ACTION_LANE = "nextMiddleware._nextAction = 'lane';";
var EXPRESS     = 'lib.lane.dispatch(_laneEntry, req, res, next, self.instance, ( self.conf[req.routing.bundle] || self.conf[self.appName] )[self.env]);';
var ROUTE       = 'return router.route(req, res, next, req.routing);';
var TERMINAL_IF = "} else if ( nextMiddleware._nextAction == 'lane' ) {";
var TERMINAL    = 'lib.lane.dispatch(nextMiddleware._laneEntry, nextMiddleware._request, nextMiddleware._response, nextMiddleware._next, self.instance, ( self.conf[nextMiddleware._request.routing.bundle] || self.conf[self.appName] )[self.env]);';
var FACTORY     = 'var createNextMiddleware = function() {';
var THROW_DECL  = 'var throwError = function(res, code, msg, next) {';


// ─── 00 — the harness ────────────────────────────────────────────────────────
describe('#P49 server wiring §00 — the harness (green without the lane)', function () {

    it('the anchors that predate the lane are found once each', function () {
        once(SRV, 'var _handleDispatch = async function(req, res, next, bundle, pathname, config) {');
        once(SRV, FACTORY);
        once(SRV, ROUTE);
        once(SRV, THROW_DECL);
        once(GNA, "_watcher.register('__hot_controllers__', conf.bundlePath + '/controllers');");
    });

    it('the real factory compiles and its route terminal reaches router.route', function () {
        var routed = [];
        var router = { route: function (req) { routed.push(req); } };
        var nm = compileFactory({
            self: { instance: { _expressMiddlewares: [function (q, r, n) { n(); }] }, conf: {}, appName: 'api', env: 'dev' },
            local: { router: router }, lib: {}, throwError: function () {}, handleStatics: function () {}
        })();
        var req = { routing: {} };
        nm._index = 0; nm._count = 0; nm._request = req; nm._response = {}; nm._next = null; nm._nextAction = 'route';
        nm();
        assert.deepEqual(routed, [req]);
    });
});


// ─── 01 — the boot walk ──────────────────────────────────────────────────────
describe('#P49 server wiring §01 — the boot walk in init()', function () {

    it('runs once, after the message-validator walk and before the authorization lint, inside init() before `configured`', function () {
        assert.equal(count(SRV, 'lib.lane.registerRoutes('), 1, 'one walk');
        var init  = once(SRV, 'var init = function(options) {');
        var msv   = once(SRV, "console.debug('[ BUNDLE ][ server ][ init ] Registered '+ _msvCount +' route message validator(s)");
        var walk  = once(SRV, WALK_CALL);
        var authz = once(SRV, 'var _authzRouting  = serverOpt.routing || {};');
        var conf  = once(SRV, "self.emit('configured'");
        assert.ok(init < msv && msv < walk && walk < authz && authz < conf, 'init → msv walk → lane walk → authz lint → configured');
    });

    it('passes the bundle, its bundles path, its settings and its resolved server block', function () {
        var at   = SRV.indexOf(WALK_CALL);
        var call = SRV.substring(at, SRV.indexOf('});', at) + 3);
        assert.match(call, /bundle\s*:\s*self\.appName\s*,/);
        assert.match(call, /bundlesPath\s*:\s*_laneConf\.bundlesPath\s*,/);
        assert.match(call, /settings\s*:\s*\(\s*_laneConf\.content\s*\)\s*\?\s*_laneConf\.content\.settings\s*:\s*null\s*,/);
        assert.match(call, /server\s*:\s*_laneConf\.server\s*\}/);
        var confAt = once(SRV, LANE_CONF);
        assert.ok(confAt < at, 'the conf read precedes the call');
    });

    it('logs the count at debug level, only when the bundle has lane routes', function () {
        var at = SRV.indexOf(WALK_CALL);
        var tail = SRV.substring(at, at + 900);
        assert.match(tail, /if \( _laneCount > 0 \) \{\s*console\.debug\('\[ BUNDLE \]\[ server \]\[ init \] Registered '\+ _laneCount \+' lane route\(s\) for \[ '\+ self\.appName \+' \]'\);/);
    });
});


// ─── 02 — the branch in _handleDispatch ──────────────────────────────────────
describe('#P49 server wiring §02 — the branch in _handleDispatch', function () {

    var HD = once(SRV, 'var _handleDispatch = async function(req, res, next, bundle, pathname, config) {');
    var M  = once(SRV, 'if (matched) {');

    it('the lookup sits after the render-cache read and before the isaac chain; one lookup in the file', function () {
        var read  = once(SRV, 'if ( await tryServeRenderCacheHit(req, res, bundle) ) {');
        var look  = once(SRV, LOOKUP);
        var chain = once(SRV, CHAIN_IF);
        assert.ok(M > HD && read > M && look > read && chain > look, 'matched → cache read → lookup → chain');
        assert.equal(count(SRV, 'lib.lane.lookup('), 1);
    });

    it('a classic route pays one property read: the lookup is guarded by `param.lane`', function () {
        assert.ok(SRV.indexOf(LOOKUP) > -1);
        assert.match(LOOKUP, /^var _laneEntry = \( req\.routing\.param && req\.routing\.param\.lane \) \? lib\.lane\.lookup/);
    });

    it('in the chain block, `\'lane\'` is set after the untouched `\'route\'` line, before the chain starts', function () {
        var chain = once(SRV, CHAIN_IF);
        var block = blockFrom(SRV, chain);
        var rt    = block.indexOf(ACTION_RT);
        var ln    = block.indexOf(ACTION_LANE);
        var start = block.indexOf('return nextMiddleware()');
        assert.ok(rt > -1 && ln > rt && start > ln, "'route' → 'lane' → the chain starts");
        assert.match(block, /if \( _laneEntry \) \{\s*nextMiddleware\._nextAction = 'lane';\s*nextMiddleware\._laneEntry  = _laneEntry;\s*\}/);
        assert.equal(count(block, 'installH2SendShim('), 1, 'the chain\'s own shim call — the lane adds none');
    });

    it('express (and isaac without middleware) dispatches the lane directly, before router.route, and returns', function () {
        var chain   = once(SRV, CHAIN_IF);
        var express = once(SRV, EXPRESS);
        var srvSet  = SRV.indexOf('router._server = self.instance;', express);
        var route   = once(SRV, ROUTE);
        assert.ok(express > chain && srvSet > express && route > srvSet, 'chain → lane dispatch → router.route');
        assert.match(SRV.substring(express - 60, express + EXPRESS.length + 40), /if \( _laneEntry \) \{\s*lib\.lane\.dispatch\([^;]*\);\s*return;\s*\}/);
    });

    it('nothing of the lane sits after the server-level throwError declaration', function () {
        var decl = once(SRV, THROW_DECL);
        assert.ok(SRV.lastIndexOf('lib.lane.') > -1, 'control: the lane is referenced');
        assert.ok(SRV.lastIndexOf('lib.lane.') < decl);
        assert.ok(SRV.lastIndexOf('_laneEntry') < decl);
    });
});


// ─── 03 — the chain terminal ─────────────────────────────────────────────────
describe('#P49 server wiring §03 — the terminal of createNextMiddleware', function () {

    it('a `\'lane\'` branch between `\'route\'` and the statics branch, dispatching the chain\'s request and response', function () {
        var factory = blockFrom(RAW_SRV, once(RAW_SRV, FACTORY));
        var rt  = factory.indexOf("if ( nextMiddleware._nextAction == 'route' ) {");
        var ln  = factory.indexOf(TERMINAL_IF);
        var st  = factory.indexOf('} else { // handle statics');
        assert.ok(rt > -1 && ln > rt && st > ln, "'route' → 'lane' → statics");
        assert.equal(count(factory, TERMINAL), 1);
        assert.ok(factory.indexOf(TERMINAL) > ln && factory.indexOf(TERMINAL) < st);
        assert.equal(count(factory, 'router.route(nextMiddleware._request, nextMiddleware._response, nextMiddleware._next, nextMiddleware._request.routing);'), 1, 'the route terminal is unchanged');
    });
});


// ─── 04 — the real bytes, run ────────────────────────────────────────────────
/** The _handleDispatch branch, from the lookup to `return router.route(…)`. */
function compileBranch() {
    var a = RAW_SRV.indexOf(LOOKUP);
    var b = RAW_SRV.indexOf(ROUTE, a);
    assert.ok(a > -1 && b > a, 'harness: the branch is found');
    return new Function('req', 'res', 'next', 'self', 'lib', 'router', 'installH2SendShim', 'createNextMiddleware',
        "'use strict';\n" + RAW_SRV.substring(a, b + ROUTE.length));
}

/** The real createNextMiddleware factory, closed over the given stubs. */
function compileFactory(env) {
    var at  = RAW_SRV.indexOf(FACTORY);
    assert.ok(at > -1, 'harness: the factory is found');
    var src = blockFrom(RAW_SRV, at).replace(/^var createNextMiddleware = /, '');
    return new Function('self', 'local', 'throwError', 'handleStatics', 'lib', "'use strict';\nreturn (" + src + ');')(
        env.self, env.local, env.throwError, env.handleStatics, env.lib
    );
}

/**
 * Run one request through the real branch and factory.
 *
 * @param {object} o - engine, middlewares, routing, entry, conf, appName
 */
function scene(o) {
    var calls  = [];
    var order  = [];
    var instance = ( o.engine === 'express' ) ? { isExpressApp: true } : { _expressMiddlewares: ( o.middlewares || [] ).map(function (mw) {
        return function (req, res, next) { order.push(mw.name); mw(req, res, next); };
    }) };
    var self = {
        engine  : o.engine || 'isaac',
        instance: instance,
        conf    : o.conf || { api: { dev: { bundle: 'api' } } },
        appName : o.appName || 'api',
        env     : 'dev'
    };
    var router = { route: function (req, res, next, routing) { calls.push({ fn: 'router.route', req: req, res: res, next: next, routing: routing, server: router._server }); } };
    var lib    = { lane: {
        lookup  : function (routing) { calls.push({ fn: 'lookup', routing: routing }); return o.entry; },
        dispatch: function (entry, req, res, next, srv, conf) { calls.push({ fn: 'dispatch', entry: entry, req: req, res: res, next: next, server: srv, conf: conf }); }
    } };
    var throwErrors = [];
    var statics     = [];
    var shimmed     = [];
    var factory = compileFactory({
        self: self, local: { router: router }, lib: lib,
        throwError: function () { throwErrors.push(Array.prototype.slice.call(arguments)); },
        handleStatics: function () { statics.push(Array.prototype.slice.call(arguments)); }
    });
    var req  = { url: '/x', routing: o.routing };
    var res  = {};
    var next = function () { calls.push({ fn: 'next' }); };
    var ret  = compileBranch()(req, res, next, self, lib, router, function (r) { shimmed.push(r); }, factory);
    return { calls: calls, order: order, throwErrors: throwErrors, statics: statics, shimmed: shimmed, req: req, res: res, next: next, self: self, ret: ret };
}

function laneRouting(bundle) { return { rule: 'users@' + ( bundle || 'api' ), bundle: bundle || 'api', param: { lane: 'users', control: 'list' } }; }
function classicRouting()    { return { rule: 'home@api', bundle: 'api', param: { control: 'home' } }; }
function mwA(req, res, next) { next(); }
function mwB(req, res, next) { next(); }
function fns(calls) { return calls.map(function (c) { return c.fn; }); }

describe('#P49 server wiring §04 — the real _handleDispatch branch and createNextMiddleware, run', function () {

    var ENTRY = { lane: 'users', control: 'list', fn: function () {} };

    it('isaac with a middleware chain: every middleware runs, then the lane — not router.route', function () {
        var s = scene({ middlewares: [mwA, mwB], routing: laneRouting(), entry: ENTRY });
        assert.deepEqual(s.order, ['mwA', 'mwB']);
        assert.deepEqual(fns(s.calls), ['lookup', 'dispatch']);
        var d = s.calls[1];
        assert.equal(d.entry, ENTRY);
        assert.equal(d.req, s.req);
        assert.equal(d.res, s.res);
        assert.equal(d.next, s.next);
        assert.equal(d.server, s.self.instance);
        assert.equal(d.conf, s.self.conf.api.dev);
        assert.deepEqual(s.shimmed, [s.res], 'the chain\'s #B562 shim, once');
        assert.equal(s.statics.length + s.throwErrors.length, 0);
    });

    it('isaac with a middleware chain, a classic route: no lookup, router.route after the chain (control)', function () {
        var s = scene({ middlewares: [mwA, mwB], routing: classicRouting(), entry: ENTRY });
        assert.deepEqual(s.order, ['mwA', 'mwB']);
        assert.deepEqual(fns(s.calls), ['router.route']);
        assert.equal(s.calls[0].routing, s.req.routing);
        assert.equal(s.calls[0].server, s.self.instance);
    });

    it('express: the lane is dispatched directly — no chain, no shim (the app\'s layers ran before)', function () {
        var s = scene({ engine: 'express', routing: laneRouting(), entry: ENTRY });
        assert.deepEqual(fns(s.calls), ['lookup', 'dispatch']);
        assert.equal(s.calls[1].next, s.next, 'express\'s own next is handed over (and never called by the lane)');
        assert.equal(s.shimmed.length, 0);
        assert.equal(s.ret, undefined);
    });

    it('express, a classic route: router.route (control)', function () {
        var s = scene({ engine: 'express', routing: classicRouting(), entry: ENTRY });
        assert.deepEqual(fns(s.calls), ['router.route']);
    });

    it('isaac without middleware: the lane is dispatched directly', function () {
        var s = scene({ middlewares: [], routing: laneRouting(), entry: ENTRY });
        assert.deepEqual(fns(s.calls), ['lookup', 'dispatch']);
        assert.equal(s.shimmed.length, 0);
    });

    it('a middleware error answers through the server throwError, as on a classic route; the lane never runs', function () {
        function mwFail(req, res, next) { next(new Error('middleware failed')); }
        var s = scene({ middlewares: [mwA, mwFail, mwB], routing: laneRouting(), entry: ENTRY });
        assert.deepEqual(s.order, ['mwA', 'mwFail']);
        assert.deepEqual(fns(s.calls), ['lookup']);
        assert.equal(s.throwErrors.length, 1);
        assert.equal(s.throwErrors[0][0], s.res);
        assert.equal(s.throwErrors[0][1], 500);
        assert.match(String(s.throwErrors[0][2]), /middleware failed/);
        assert.equal(s.throwErrors[0][4], 'lane', 'the chain reports the pending action');
    });

    it('a middleware handing on a replacement request and response: the lane receives those', function () {
        var req2 = { url: '/x', routing: laneRouting(), replaced: true };
        var res2 = { replaced: true };
        function mwSwap(req, res, next) { next(null, req2, res2); }
        var s = scene({ middlewares: [mwA, mwSwap], routing: laneRouting(), entry: ENTRY });
        var d = s.calls[s.calls.length - 1];
        assert.equal(d.fn, 'dispatch');
        assert.equal(d.req, req2);
        assert.equal(d.res, res2);
    });

    it('a merged bundle\'s lane route gets its own bundle configuration; an unknown bundle falls back to the starting one', function () {
        var conf = { api: { dev: { bundle: 'api' } }, admin: { dev: { bundle: 'admin' } } };
        var s1 = scene({ middlewares: [mwA], routing: laneRouting('admin'), entry: ENTRY, conf: conf });
        assert.equal(s1.calls[1].conf, conf.admin.dev);
        var s2 = scene({ engine: 'express', routing: laneRouting('admin'), entry: ENTRY, conf: conf });
        assert.equal(s2.calls[1].conf, conf.admin.dev);
        var s3 = scene({ middlewares: [mwA], routing: laneRouting('ghost'), entry: ENTRY, conf: conf });
        assert.equal(s3.calls[1].conf, conf.api.dev);
    });

    it('the `missing` placeholder is dispatched like any entry (lib/lane answers it with a 500)', function () {
        var missing = { missing: true, key: 'api::users#list', bundle: 'api', lane: 'users', control: 'list', rule: 'users@api' };
        var s = scene({ middlewares: [mwA], routing: laneRouting(), entry: missing });
        assert.equal(s.calls[1].entry, missing);
        assert.deepEqual(fns(s.calls), ['lookup', 'dispatch']);
    });
});


// ─── 05 — core/gna.js ────────────────────────────────────────────────────────
describe('#P49 server wiring §05 — core/gna.js: the dev-mode watch of the lane directories', function () {

    var BLOCK_START = "var _laneDirs = lib.lane.watchDirs(conf.bundlePath + '/lanes');";

    /** The real watcher block, from the watchDirs() call to the end of its loop. */
    function compileWatchBlock() {
        var a = RAW_GNA.indexOf(BLOCK_START);
        assert.ok(a > -1, 'harness: the block is found');
        var loop = RAW_GNA.indexOf('for (var _ld = 0; _ld < _laneDirs.length; ++_ld) {', a);
        assert.ok(loop > a, 'harness: its loop is found');
        var end = loop + blockFrom(RAW_GNA, loop).length;
        return new Function('lib', 'conf', '_watcher', '_hotDirty', "'use strict';\n" + RAW_GNA.substring(a, end));
    }

    it('the dev dirty flags carry `lane`', function () {
        assert.equal(count(GNA, 'var _hotDirty = { core: false, action: false, lane: false };'), 1);
    });

    it('the block sits in the dev branch, after the controllers watch and before the watcher starts', function () {
        var dev   = once(GNA, "_watcher.register('__hot_controllers__', conf.bundlePath + '/controllers');");
        var block = once(GNA, BLOCK_START);
        var start = once(GNA, '_watcher.start();');
        assert.ok(block > dev && start > block);
    });

    it('a `change` and a `rename` watch for each directory watchDirs() returns, each setting the lane flag', function () {
        var seen = { watchDirs: [], register: [], on: {} };
        var lib = { lane: { watchDirs: function (root) { seen.watchDirs.push(root); return ['/b/lanes', '/b/lanes/admin']; } } };
        var watcher = {
            register: function (name, p, opts) { seen.register.push([name, p, opts]); },
            on      : function (name, fn) { seen.on[name] = fn; }
        };
        var dirty = { core: false, action: false, lane: false };
        compileWatchBlock()(lib, { bundlePath: '/b' }, watcher, dirty);
        assert.deepEqual(seen.watchDirs, ['/b/lanes']);
        assert.deepEqual(seen.register, [
            ['__hot_lanes_0__',        '/b/lanes',       undefined],
            ['__hot_lanes_0_rename__', '/b/lanes',       { event: 'rename' }],
            ['__hot_lanes_1__',        '/b/lanes/admin', undefined],
            ['__hot_lanes_1_rename__', '/b/lanes/admin', { event: 'rename' }]
        ]);
        Object.keys(seen.on).forEach(function (name) {
            dirty.lane = false;
            seen.on[name]('change', '/b/lanes/x.js');
            assert.equal(dirty.lane, true, name + ' sets the flag');
            assert.equal(dirty.action, false, name + ' leaves the controllers flag alone');
        });
        assert.equal(Object.keys(seen.on).length, 4);
    });

    it('nothing is watched for a bundle without lane routes', function () {
        var registered = 0;
        compileWatchBlock()(
            { lane: { watchDirs: function () { return []; } } },
            { bundlePath: '/b' },
            { register: function () { ++registered; }, on: function () {} },
            { lane: false }
        );
        assert.equal(registered, 0);
    });
});
