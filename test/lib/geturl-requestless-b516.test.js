/**
 * #B516 — the `getUrl` filter in a render context that has no request, or no
 * bundle configuration (real bytes, both engines).
 *
 * WHAT THIS FILE IS. It drives the REAL `lib/swig-filters` and
 * `lib/nunjucks-filters` factories — not a replica. Every case builds a filter
 * context by hand, calls the factory with it and then calls `getUrl`
 * synchronously, so the filter resolves exactly the context the arm stamped
 * (no render store and no request store are active in this process).
 *
 * THE DEFECT. `getUrl` sends every rule form, and every path with a bundle
 * base, through a branch that read `ctx.req.headers` unguarded, and it read
 * `ctx.options.conf` unguarded before that. A context with no `req` (a mail or
 * cron render, a library building the filters outside a request) threw
 * `TypeError … reading 'headers'`; a context with no `options.conf` (the boot
 * registration, an async delegate's context-free registration) threw
 * `TypeError … reading 'bundle'` / `'webroot'` on every form, a plain path
 * included.
 *
 * THE CONTRACT PINNED HERE. Such a context DEGRADES: the URL is built from the
 * target bundle's configured hostname, or from the worker's proxy host when
 * one is known — what a caller with no request in scope gets from
 * `lib.routing.getRoute()`. It never emits `:NaN` or `scheme://undefined`. Two
 * cases still throw, with a named `Error` instead of a `TypeError`: an unknown
 * bundle when the context has no `throwError`, and no bundle configuration
 * anywhere. A context that carries a request is used as it is.
 *
 * HONEST SCOPE.
 *   (a) The Config registry is a stub with two bundles and no routing table,
 *       so a rule form returns the filter's own `404:[GET]<rule>` marker on
 *       both sides of a pair: those arms pin "does not throw, same answer as
 *       with a request", not a resolved route URL.
 *   (b) The factory needs two gina globals that only `gna.js` sets at bundle
 *       boot (`GINA_FRAMEWORK_DIR`, `_`); they are shimmed minimally and
 *       restored. Its first call requires `lib/routing`, which installs gina's
 *       real `getContext` / `setContext`, so the registry stub is seeded
 *       through those AFTER a warm-up call and read back before any arm.
 *   (c) Red-first: on the pre-fix bytes the request-less and conf-less arms
 *       throw a TypeError; the instrument, the with-request controls and the
 *       unknown-bundle control pass on both sides.
 */

'use strict';

var path   = require('path');
var { describe, it, before, after, afterEach } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function confFor(bundle, port) {
    return {
        bundle   : bundle,
        bundles  : ['web', 'api'],
        hostname : 'http://localhost:' + port,
        host     : 'localhost',
        server   : { webroot: '/', protocol: 'http/1.1', scheme: 'http' },
        port     : { 'http/1.1': { http: port } },
        routing  : {}
    };
}
var CONF = { web: confFor('web', 3100), api: confFor('api', 3200) };
var GINA = {
    Config: { instance: {
        allBundles : ['web', 'api'],
        bundles    : ['web', 'api'],
        env        : 'dev',
        Env        : { getConf: function (b) { return CONF[b] ? clone(CONF[b]) : null; } }
    } }
};

var ENGINES = [
    { name: 'swig',     lib: 'lib/swig-filters' },
    { name: 'nunjucks', lib: 'lib/nunjucks-filters' }
];

var priorGlobals = {};
var priorGina    = null;

before(function () {
    priorGlobals.FWDIR = global.GINA_FRAMEWORK_DIR;
    priorGlobals.under = global._;
    global.GINA_FRAMEWORK_DIR = FW;
    // Faithful for the one use the factories make of it: building require paths.
    if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }
    priorGina = process.gina;
});

after(function () {
    if (typeof priorGlobals.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; }
    else { global.GINA_FRAMEWORK_DIR = priorGlobals.FWDIR; }
    if (typeof priorGlobals.under === 'undefined') { delete global._; }
    else { global._ = priorGlobals.under; }
    if (typeof priorGina === 'undefined') { delete process.gina; }
    else { process.gina = priorGina; }
});

ENGINES.forEach(function (engine) {

    describe('#B516 - getUrl without a request or a bundle conf (real ' + engine.lib + ')', function () {

        var Factory = null;
        var errorLog = null;

        /** A context as a render delegate builds it: options.conf + req + res + throwError. */
        function requestCtx(extra) {
            var c = {
                options     : { conf: clone(CONF.web), rule: 'home@web', method: 'GET' },
                isProxyHost : false,
                throwError  : function () { c._thrown = Array.prototype.slice.call(arguments); },
                req         : { headers: { host: 'localhost:3100', port: '3100' }, method: 'GET' },
                res         : {}
            };
            return Object.assign(c, extra || {});
        }

        /** The same context with no request at all: what a mail or cron renderer hands in. */
        function requestLessCtx(extra) {
            return Object.assign({
                options     : { conf: clone(CONF.web), rule: 'home@web', method: 'GET' },
                isProxyHost : false
            }, extra || {});
        }

        /** Stamp `ctx` and call getUrl synchronously: the filter resolves this arm's context. */
        function getUrlWith(ctx, args) {
            var filters = Factory(ctx);
            return filters.getUrl.apply(filters, args);
        }

        before(function () {
            process.gina = {};   // a worker that never saw a proxied request; no render store, no request store
            Factory = require(path.join(FW, engine.lib));
            // The first call requires lib/routing, which installs gina's real context accessors.
            Factory(requestCtx());
            assert.equal(typeof setContext, 'function', 'gina setContext must be live after the warm-up call');
            setContext('gina', GINA);
            setContext('bundle', 'web');
            // The stub registry has no routing table, so a rule form logs the routing
            // exception it then turns into the 404 marker: keep that out of the test output.
            errorLog = console.error;
            console.error = function () {};
        });

        after(function () {
            console.error = errorLog;
        });

        afterEach(function () {
            delete process.gina.PROXY_HOST;
            delete process.gina.PROXY_HOSTNAME;
            delete process.gina.PROXY_PORT;
            setContext('bundle', 'web');
        });

        // --- instrument ------------------------------------------------------------

        it('instrument: the registry seed reads back, and a request context resolves every form', function () {
            assert.equal(getContext('bundle'), 'web');
            assert.equal(getContext('gina').Config.instance.allBundles.length, 2);
            assert.equal(getUrlWith(requestCtx(), ['/dashboard', null, 'api']), 'http://localhost:3200//dashboard');
            assert.equal(getUrlWith(requestCtx(), ['home']), '404:[GET]home@web');
            assert.equal(getUrlWith(requestCtx(), ['home@api']), '404:[GET]home@api');
            assert.equal(getUrlWith(requestCtx(), ['/css/main.css']), '/css/main.css');
        });

        // --- a context with no request ---------------------------------------------

        it('a path with a bundle base returns the same URL without a request as with one', function () {
            var withReq = getUrlWith(requestCtx(), ['/dashboard', null, 'api']);
            var without = getUrlWith(requestLessCtx(), ['/dashboard', null, 'api']);
            assert.equal(without, withReq);
        });

        it('a rule of the current bundle returns the same answer without a request as with one', function () {
            var withReq = getUrlWith(requestCtx(), ['home']);
            var without = getUrlWith(requestLessCtx(), ['home']);
            assert.equal(without, withReq);
        });

        it('a rule@bundle reference returns the same answer without a request as with one', function () {
            var withReq = getUrlWith(requestCtx(), ['home@api']);
            var without = getUrlWith(requestLessCtx(), ['home@api']);
            assert.equal(without, withReq);
        });

        it('the routing-catch marker takes its method from the context when there is no request', function () {
            var ctx = requestLessCtx();
            ctx.options.method = 'POST';
            assert.equal(getUrlWith(ctx, ['home']), '404:[POST]home@web');
        });

        it('on a worker that knows its proxy host, a request-less URL is built from that host', function () {
            process.gina.PROXY_HOST     = 'pub.example';
            process.gina.PROXY_HOSTNAME = 'https://pub.example';
            process.gina.PROXY_PORT     = '443';
            assert.equal(getUrlWith(requestLessCtx(), ['/dashboard', null, 'api']), 'http://pub.example/dashboard');
        });

        it('a proxied classification with no proxy host anywhere keeps the configured hostname', function () {
            var url = getUrlWith(requestLessCtx({ isProxyHost: true }), ['/dashboard', null, 'api']);
            assert.equal(url, 'http://localhost:3200/dashboard');
            assert.equal(url.indexOf('undefined'), -1, 'never scheme://undefined');
            assert.equal(url.indexOf('NaN'), -1, 'never :NaN');
        });

        it('a proxy host with no port known anywhere gets no port appended', function () {
            process.gina.PROXY_HOST     = 'pub.example';
            process.gina.PROXY_HOSTNAME = 'https://pub.example';
            var url = getUrlWith(requestLessCtx({ isProxyHost: true }), ['/x', null, 'web']);
            assert.equal(url, 'http://pub.example/x');
            assert.equal(url.indexOf('NaN'), -1, 'never :NaN');
        });

        it('an unknown bundle with no throwError in the context throws a named Error', function () {
            assert.throws(function () {
                getUrlWith(requestLessCtx(), ['/x', null, 'nope']);
            }, function (err) {
                assert.ok(err instanceof Error);
                assert.equal(err instanceof TypeError, false, 'a named Error, not a TypeError: ' + err.message);
                assert.match(err.message, /bundle `nope` not found/);
                return true;
            });
        });

        it('control: an unknown bundle on a request context still answers through ctx.throwError', function () {
            var ctx = requestCtx();
            getUrlWith(ctx, ['/x', null, 'nope']);
            assert.ok(Array.isArray(ctx._thrown), 'ctx.throwError must have been called');
            assert.equal(ctx._thrown[0], ctx.res);
            assert.equal(ctx._thrown[1], 500);
            assert.match(String(ctx._thrown[2]), /bundle `nope` not found/);
        });

        // --- a context with no bundle configuration -----------------------------------

        [
            ['the context-free registration shape { options: {} }', function () { return { options: {}, isProxyHost: false }; }],
            ['the boot registration shape { options: <bundle conf> }', function () { return { options: clone(CONF.web), isProxyHost: undefined }; }]
        ].forEach(function (shape) {

            it(shape[0] + ': a plain path resolves', function () {
                assert.equal(getUrlWith(shape[1](), ['/css/main.css']), '/css/main.css');
            });

            it(shape[0] + ': a rule takes the current bundle from the registry', function () {
                assert.equal(getUrlWith(shape[1](), ['home']), '404:[GET]home@web');
            });

            it(shape[0] + ': a path with a bundle base resolves', function () {
                assert.equal(getUrlWith(shape[1](), ['/dashboard', null, 'api']), 'http://localhost:3200//dashboard');
            });
        });

        it('no bundle configuration in the context and none in the registry throws a named Error', function () {
            setContext('bundle', 'ghost');
            assert.throws(function () {
                getUrlWith({ options: {}, isProxyHost: false }, ['/css/main.css']);
            }, function (err) {
                assert.equal(err instanceof TypeError, false, 'a named Error, not a TypeError: ' + err.message);
                assert.match(err.message, /no bundle configuration/);
                assert.match(err.message, /ghost/);
                return true;
            });
        });

        // --- the caller's context is never written ------------------------------------

        it('the view is local: neither a request-less nor a request context object is written', function () {
            var bare = requestLessCtx({ isProxyHost: true });
            var bareKeys = Object.keys(bare).sort().join(',');
            getUrlWith(bare, ['/dashboard', null, 'api']);
            assert.equal(Object.keys(bare).sort().join(','), bareKeys);
            assert.equal(typeof bare.req, 'undefined');

            var full = requestCtx();
            var headers = JSON.stringify(full.req.headers);
            getUrlWith(full, ['/dashboard', null, 'api']);
            assert.equal(JSON.stringify(full.req.headers), headers);
        });
    });
});
