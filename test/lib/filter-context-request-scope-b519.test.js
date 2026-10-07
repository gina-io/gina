/**
 * #B519 / #B809 — the template filters' context is bound to the request
 * (real bytes, both engines). The class guard.
 *
 * THE RULE THIS FILE GUARDS. `getUrl`, `getWebroot`, `t` and `tIcu` find their
 * context at call time. Inside a request that context is the request's own —
 * a render store first, else the request store `core/server.js` handle() opens
 * — and the process-wide slot (`<Filters>.instance._options`) is neither read
 * nor written. Outside a request the slot is used, and it only ever holds a
 * context stamped outside a request.
 *
 * WHY. Every factory call used to stamp the slot, and every reader with no
 * render store of its own read it. So a template run in an action outside a
 * render delegate resolved the context of whichever request had rendered last
 * (#B809, no concurrency needed), and a cron, worker or WebSocket render
 * resolved the last request's context too.
 *
 * WHAT THIS FILE IS. The REAL `lib/swig-filters` and `lib/nunjucks-filters`
 * factories under real `AsyncLocalStorage` stores, shaped as the framework
 * shapes them: handle()'s `{ requestId, startMs, proxy, req, res, next }`, the
 * controller's registration (`options`, `throwError`), a render delegate's
 * render store, `lib/job`'s detached copy. An accessor trap on
 * `<Filters>.instance._options` counts every read and write of the slot. Each
 * simulated request starts from one async resource captured before any store is
 * entered, as a real request starts from its own I/O callback.
 *
 * The discriminator is the URL host: each request context is classified
 * proxied with its own proxy host, so the host in a `getUrl` result names the
 * context that was resolved.
 *
 * HONEST SCOPE.
 *   (a) The requests are simulated: nothing here boots a bundle or opens a
 *       socket. The delegates and the controller are tied to the rule by the
 *       source pins of §05, not by a drive.
 *   (b) Red-first: on the pre-fix bytes the request arms read or write the
 *       slot, or resolve another request's host; the trap instrument and the
 *       render-store arm pass on both sides.
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it, before, after, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var { AsyncLocalStorage, AsyncResource } = require('async_hooks');

var FW = require('../fw');

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function read(rel) { return fs.readFileSync(path.join(FW, rel), 'utf8'); }
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

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
var CONFIG_URL = 'http://localhost:3200//dashboard';   // what a context with no request resolves

/** A request as an engine hands it on: classified proxied, with ITS OWN proxy host. */
function requestFor(host) {
    return {
        headers            : { host: host, port: '443' },
        method             : 'GET',
        _ginaIsProxyHost   : true,
        _ginaProxyHost     : host,
        _ginaProxyHostname : 'https://' + host
    };
}
/** The context a render delegate builds for a request. */
function delegateCtx(req) {
    return {
        options     : { conf: clone(CONF.web), rule: 'home@web', method: 'GET' },
        isProxyHost : true,
        throwError  : function () {},
        req         : req,
        res         : {}
    };
}
function hostOf(url) { return String(url).replace(/^https?:\/\//, '').split('/')[0]; }

/**
 * A REAL template engine carrying the given gina filter table, as a bundle's engine does.
 * Returns a function that executes one compiled template, or null when the engine is not
 * installed here (nunjucks is a project-side dependency).
 */
function realEngineRender(name, filters) {
    try {
        if (name === 'swig') {
            var swig = require(path.join(FW, 'node_modules/@rhinostone/swig'));
            var engine = new swig.Swig({ autoescape: false, cache: false });
            engine.setFilter('getUrl', filters.getUrl);
            var tpl = engine.compile("{{ '/dashboard'|getUrl(null, 'api') }}");
            return function () { return tpl({}); };
        }
        var nunjucks = require('nunjucks');
        var env = new nunjucks.Environment(null, { autoescape: false });
        env.addFilter('getUrl', filters.getUrl);
        return function () { return env.renderString("{{ '/dashboard' | getUrl(null, 'api') }}", {}); };
    } catch (e) {
        return null;
    }
}

var ROOT = new AsyncResource('b519-root');   // captured before any store is entered
var priorGlobals = {};
var priorGina    = null;

/** One request, as server.js handle() runs it: its own async context and its own store. */
function inRequest(req, fn) {
    var store = { requestId: 'r-' + req.headers.host, startMs: Date.now(), proxy: null, req: req, res: {}, next: function () {} };
    return ROOT.runInAsyncScope(function () {
        return process.gina._reqALS.run(store, function () { return fn(store); });
    });
}
/** What controller.setOptions registers on the request store. */
function registerController(store) {
    store.options    = { conf: clone(CONF.web), rule: 'home@web', method: 'GET' };
    store.throwError = function () {};
}
/** Code with no request at all: boot, a cron task, a worker. */
function outsideAnyRequest(fn) { return ROOT.runInAsyncScope(fn); }

before(function () {
    priorGlobals.FWDIR = global.GINA_FRAMEWORK_DIR;
    priorGlobals.under = global._;
    global.GINA_FRAMEWORK_DIR = FW;
    if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }
    priorGina = process.gina;
    process.gina = { _reqALS: new AsyncLocalStorage(), _renderALS: new AsyncLocalStorage() };
});

after(function () {
    if (typeof priorGlobals.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; }
    else { global.GINA_FRAMEWORK_DIR = priorGlobals.FWDIR; }
    if (typeof priorGlobals.under === 'undefined') { delete global._; }
    else { global._ = priorGlobals.under; }
    if (typeof priorGina === 'undefined') { delete process.gina; }
    else { process.gina = priorGina; }
});

[
    { name: 'swig',     lib: 'lib/swig-filters' },
    { name: 'nunjucks', lib: 'lib/nunjucks-filters' }
].forEach(function (engine) {

    describe('#B519 - the filter context is bound to the request (real ' + engine.lib + ')', function () {

        var Factory = null;
        var filters = null;
        var slot    = { value: undefined, reads: 0, writes: 0 };
        var ARGS    = ['/dashboard', null, 'api'];

        function resetCounts() { slot.reads = 0; slot.writes = 0; }

        before(function () {
            Factory = require(path.join(FW, engine.lib));
            // The process's first factory call is a boot-shaped one, outside any request.
            filters = outsideAnyRequest(function () {
                return Factory({ options: clone(CONF.web), isProxyHost: undefined });
            });
            setContext('gina', GINA);
            setContext('bundle', 'web');
            // The trap: every read and write of the process-wide slot is counted.
            slot.value = Factory.instance._options;
            Object.defineProperty(Factory.instance, '_options', {
                configurable : true,
                enumerable   : true,
                get          : function () { slot.reads++; return slot.value; },
                set          : function (v) { slot.writes++; slot.value = v; }
            });
        });

        after(function () {
            delete Factory.instance._options;
            Factory.instance._options = slot.value;
        });

        beforeEach(function () {
            // A boot-shaped stamp is what the slot holds before each arm.
            outsideAnyRequest(function () { Factory({ options: clone(CONF.web), isProxyHost: undefined }); });
            resetCounts();
        });

        // --- 01 instrument ------------------------------------------------------

        it('01 instrument: outside any request the trap counts the factory write and the filter read', function () {
            outsideAnyRequest(function () {
                Factory({ options: clone(CONF.web), isProxyHost: undefined });
                assert.equal(slot.writes, 1, 'a factory call outside a request stamps the slot');
                assert.equal(filters.getUrl.apply(filters, ARGS), CONFIG_URL);
                assert.ok(slot.reads >= 1, 'a filter call outside a request reads the slot');
            });
        });

        it('01 instrument: the host in a URL names the context that was resolved', function () {
            var url = outsideAnyRequest(function () {
                return process.gina._renderALS.run(delegateCtx(requestFor('a.example')), function () {
                    return filters.getUrl.apply(filters, ARGS);
                });
            });
            assert.equal(hostOf(url), 'a.example');
        });

        // --- 02 inside a request: the request's own context, never the slot ---------

        it('02 a render inside its render store resolves its own request, after another request rendered', function () {
            inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                var ctx = delegateCtx(store.req);
                Factory(ctx);
                process.gina._renderALS.run(ctx, function () { filters.getUrl.apply(filters, ARGS); });
            });
            resetCounts();
            var url = inRequest(requestFor('b.example'), function (store) {
                registerController(store);
                var ctx = delegateCtx(store.req);
                Factory(ctx);
                return process.gina._renderALS.run(ctx, function () { return filters.getUrl.apply(filters, ARGS); });
            });
            assert.equal(hostOf(url), 'b.example');
            assert.equal(slot.reads, 0, 'no read of the process-wide slot inside a request');
            assert.equal(slot.writes, 0, 'no write of the process-wide slot inside a request');
        });

        it('02 a template run in an action outside any render store resolves ITS request (#B809)', function () {
            // request A renders: its delegate calls the factory and enters the render store
            inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                var ctx = delegateCtx(store.req);
                Factory(ctx);
                process.gina._renderALS.run(ctx, function () { filters.getUrl.apply(filters, ARGS); });
            });
            resetCounts();
            // request B, later, with no concurrency: an action runs a template through the
            // engine before any render — no factory call, no render store
            var url = inRequest(requestFor('b.example'), function (store) {
                registerController(store);
                return filters.getUrl.apply(filters, ARGS);
            });
            assert.equal(hostOf(url), 'b.example', 'never the request that rendered last');
            assert.equal(slot.reads, 0);
            assert.equal(slot.writes, 0);
        });

        it('02 a real engine executing a template in an action resolves ITS request (#B809)', function (t) {
            var render = realEngineRender(engine.name, filters);
            if (!render) { return t.skip(engine.name + ' is not installed here'); }
            // request A renders through its delegate: factory call + render store
            var first = inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                var ctx = delegateCtx(store.req);
                Factory(ctx);
                return process.gina._renderALS.run(ctx, render);
            });
            assert.equal(first, 'http://a.example/dashboard', 'control: the engine runs the real filter');
            resetCounts();
            // request B: an action executes the template through the engine, outside any render
            var html = inRequest(requestFor('b.example'), function (store) {
                registerController(store);
                return render();
            });
            assert.equal(html, 'http://b.example/dashboard');
            assert.equal(slot.reads, 0);
            assert.equal(slot.writes, 0);
        });

        it('02 a request with no controller registered yet still resolves its own request', function () {
            inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                Factory(delegateCtx(store.req));
            });
            resetCounts();
            var url = inRequest(requestFor('b.example'), function () {
                return filters.getUrl.apply(filters, ARGS);
            });
            assert.equal(hostOf(url), 'b.example');
            assert.equal(slot.reads, 0);
        });

        it('02 a factory call made in an action resolves its own context and stamps nothing process-wide', function () {
            var url = inRequest(requestFor('b.example'), function (store) {
                registerController(store);
                var own = delegateCtx(requestFor('own.example'));
                var f = Factory(own);
                return f.getUrl.apply(f, ARGS);
            });
            assert.equal(hostOf(url), 'own.example', 'the factory call resolves the context it was given');
            assert.equal(slot.writes, 0, 'bound to the request, not to the process');
            assert.equal(slot.reads, 0);
        });

        it('02 two requests each keep the context their own factory call bound', function () {
            var urlA, urlB;
            inRequest(requestFor('a.example'), function (storeA) {
                var fa = Factory(delegateCtx(storeA.req));
                inRequest(requestFor('b.example'), function (storeB) {
                    var fb = Factory(delegateCtx(storeB.req));
                    urlB = fb.getUrl.apply(fb, ARGS);
                });
                // A resumes after B stamped: it must still resolve A
                urlA = fa.getUrl.apply(fa, ARGS);
            });
            assert.equal(hostOf(urlA), 'a.example');
            assert.equal(hostOf(urlB), 'b.example');
            assert.equal(slot.writes, 0);
            assert.equal(slot.reads, 0);
        });

        // --- 03 outside a request: the slot, and never a request's context -----------

        it('03 a caller with no request reads the slot and never gets the last request\'s context', function () {
            inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                var ctx = delegateCtx(store.req);
                Factory(ctx);
                process.gina._renderALS.run(ctx, function () { filters.getUrl.apply(filters, ARGS); });
            });
            resetCounts();
            var url = outsideAnyRequest(function () { return filters.getUrl.apply(filters, ARGS); });
            assert.equal(url, CONFIG_URL, 'the boot-shaped stamp, not request A');
            assert.ok(slot.reads >= 1, 'control: this arm does read the slot');
        });

        it('03 a job\'s detached copy of a request context counts as no request', function () {
            inRequest(requestFor('a.example'), function (store) {
                registerController(store);
                Factory(delegateCtx(store.req));
            });
            resetCounts();
            var url = ROOT.runInAsyncScope(function () {
                return process.gina._reqALS.run({ requestId: 'r-a.example', startMs: Date.now(), proxy: null, detached: true }, function () {
                    return filters.getUrl.apply(filters, ARGS);
                });
            });
            assert.equal(url, CONFIG_URL);
            assert.ok(slot.reads >= 1, 'control: this arm does read the slot');
        });

        it('03 a factory call outside a request still resolves its own context through the slot', function () {
            var url = outsideAnyRequest(function () {
                var f = Factory({ options: { conf: clone(CONF.web) }, isProxyHost: false });
                return f.getUrl.apply(f, ARGS);
            });
            assert.equal(url, CONFIG_URL);
            assert.equal(slot.writes, 1);
        });

        // --- 04 the first call of a module instance (every request, in development) --

        it('04 a module instance whose FIRST call is a request\'s keeps no request context', function () {
            var file = require.resolve(path.join(FW, engine.lib));
            var cached = require.cache[file];
            delete require.cache[file];
            var Fresh, fresh;
            try {
                Fresh = require(file);
                inRequest(requestFor('a.example'), function (store) {
                    registerController(store);
                    fresh = Fresh(delegateCtx(store.req));      // the instance's first call
                    assert.equal(hostOf(fresh.getUrl.apply(fresh, ARGS)), 'a.example');
                });
                // later, with no request: the instance must not hand request A's context out
                var url = outsideAnyRequest(function () { return fresh.getUrl.apply(fresh, ARGS); });
                assert.equal(url, CONFIG_URL);
                assert.equal(Object.prototype.hasOwnProperty.call(Fresh.instance, '_options'), false,
                    'a first call made inside a request stamps no process-wide slot');
            } finally {
                delete require.cache[file];
                if (cached) { require.cache[file] = cached; }
            }
        });
    });
});

// --- 05 source pins: the framework side of the rule --------------------------------

describe('#B519 §05 - the delegates and the controller keep the rule (source)', function () {

    it('the default swig delegate enters the render store right after its factory call', function () {
        var src = stripComments(read('core/controller/controller.render-swig.js'));
        var factory = src.indexOf('var filters = SwigFilters(_renderCtx);');
        var enter   = src.indexOf('getRenderALS().enterWith(_renderCtx);');
        assert.ok(factory > -1 && enter > factory, 'factory call, then enterWith');
        assert.equal(/\bawait\b/.test(src.slice(factory, enter)), false, 'no await between the two');
    });

    it('the default nunjucks delegate runs both render calls inside the render store', function () {
        var src = stripComments(read('core/controller/controller.render-nunjucks.js'));
        assert.match(src, /getRenderALS\(\)\.run\(_filterCtx, function \(\) \{\s*html = env\.render\(templateRel, data\);\s*\}\);/);
        assert.match(src, /getRenderALS\(\)\.run\(_filterCtx, function \(\) \{\s*html = env\.renderString\(_errSource, data\);\s*\}\);/);
        assert.match(src, /_filterCtx = registerGinaFilters\(env, self, local, localOptions, req, res\);/);
        // the store's context carries the same five values, by reference, as the factory call
        var ret = src.match(/return \{\s*options:\s*localOptions,\s*isProxyHost:\s*isProxyHost,\s*throwError:\s*self\.throwError,\s*req:\s*req,\s*res:\s*res\s*\};\s*\}/);
        assert.ok(ret, 'registerGinaFilters returns the five-value context');
        assert.equal((src.match(/env\.render(String)?\(/g) || []).length, 2, 'no render call outside the store');
    });

    it('the two async delegates run their render inside the render store', function () {
        ['core/controller/controller.render-swig-async.js', 'core/controller/controller.render-nunjucks-async.js'].forEach(function (rel) {
            assert.match(stripComments(read(rel)), /getRenderALS\(\)\.run\(_renderStore, async function \(\) \{/, rel);
        });
    });

    it('controller.setOptions registers the request\'s options and responder on ITS store only', function () {
        var src = stripComments(read('core/controller/controller.js'));
        var start = src.indexOf('this.setOptions = function(req, res, next, options) {');
        assert.ok(start > -1);
        var body = src.slice(start, start + 1400);
        assert.match(body, /_reqStore && _reqStore\.req === req/);
        assert.match(body, /_reqStore\.options\s*=\s*options;/);
        assert.match(body, /_reqStore\.throwError\s*=\s*self\.throwError;/);
    });

    it('handle() opens the request store with the request it dispatches', function () {
        var src = stripComments(read('core/server.js'));
        assert.match(src, /var _reqStore = \{[\s\S]{0,400}req\s*:\s*req,[\s\S]{0,80}res\s*:\s*res,[\s\S]{0,80}next\s*:\s*next\s*\};\s*return process\.gina\._reqALS\.run\(_reqStore, function\(\) \{/);
    });

    it('both filter libs read the request store before the process-wide slot, and bind to it', function () {
        [['lib/swig-filters/src/main.js', 'SwigFilters'], ['lib/nunjucks-filters/src/main.js', 'NunjucksFilters']].forEach(function (pair) {
            var src = stripComments(read(pair[0]));
            var acc = src.slice(src.indexOf('var getRenderCtx = function'));
            var reqRead  = acc.indexOf('process.gina._reqALS.getStore()');
            var slotRead = acc.indexOf(pair[1] + '.instance._options');
            assert.ok(reqRead > -1 && slotRead > reqRead, pair[0] + ': request store first');
            assert.match(src, /_reqStore\.filterCtx = conf;/, pair[0] + ': a call inside a request binds to it');
        });
    });

    it('the process-wide slot is named in the two filter libs only', function () {
        var hits = [];
        (function walk(dir) {
            fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
                var abs = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test' || e.name === 'vendor') { return; }
                    return walk(abs);
                }
                if (!/\.js$/.test(e.name) || /\.min\.js$/.test(e.name)) { return; }
                if (/(SwigFilters|NunjucksFilters|[Ff]ilters)\.instance\._options/.test(stripComments(fs.readFileSync(abs, 'utf8')))) {
                    hits.push(path.relative(FW, abs));
                }
            });
        })(FW);
        assert.deepEqual(hits.sort(), ['lib/nunjucks-filters/src/main.js', 'lib/swig-filters/src/main.js']);
    });
});
