'use strict';
/**
 * #B807 — a route middleware and a bundle's `controllers/setup.js` reach the controller methods of
 * THEIR OWN request, before and after an await.
 *
 * core/router.js used to hand both of them the request's controller methods by WRITING those
 * methods onto a shared object: the middleware class's `prototype`, and the cached `setup.js`
 * export (controller.render-nunjucks.js wrote the same export). A method is looked up when it is
 * CALLED, and a cached module is shared by every request, so a call made after an await reached
 * the controller of whichever request had passed through the same file last: the answer went to
 * that request's response, and its own request was never answered.
 *
 * The router now builds a per-request prototype layer for each middleware instance (an object
 * inheriting from the class's prototype carries the methods, and the instance is constructed on
 * it) and runs `setup.js` on a per-run receiver inheriting from the export, at both call sites.
 * Nothing is written onto the shared class or onto the export.
 *
 *  01 extraction controls — every region below is sliced out of the source under test.
 *  02 route middlewares, behavioural — the REAL `processMiddlewares` bytes compiled with their
 *     closure inputs, real middleware files on disk, the real require cache. Two dispatches A and
 *     B, each with its own controller; the middleware awaits a promise the test releases, then
 *     answers. The reading is which controller receives each answer.
 *  03 route middlewares — what the change kept: methods reachable in the constructor body, own
 *     properties, members of the exported prototype, instanceof, a shared twin, a chain.
 *  04 `setup.js` through the router's wrapper — the same reading, plus the receiver's contract.
 *  05 `setup.js` through the nunjucks delegate, and the two call sites on one export.
 *  06 source pins on the three regions, comment-stripped, each with the strip's own control.
 *
 * Seams: GINA_ROUTER_SRC=<absolute file> and GINA_RENDER_NUNJUCKS_SRC=<absolute file> run every
 * arm against those texts. Red-first against the pre-change bytes
 * (`git show <sha>:<fw>/core/router.js > <file>`): the arms that pin the change read RED, the arms
 * labelled CONTROL pin what it kept and stay GREEN. No arm waits on a callback of the code under
 * test: each settles on the event loop's check phase, so a regression fails and never hangs.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var Module = require('module');

var FW              = require('../fw');
var ROUTER_SOURCE   = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var NUNJUCKS_SOURCE = process.env.GINA_RENDER_NUNJUCKS_SRC || path.join(FW, 'core/controller/controller.render-nunjucks.js');
var inherits        = require(path.join(FW, 'lib/inherits/src/main'));

var ROUTER_SRC   = fs.readFileSync(ROUTER_SOURCE, 'utf8');
var NUNJUCKS_SRC = fs.readFileSync(NUNJUCKS_SOURCE, 'utf8');

function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
/** Slices `text` from the unique `start` literal up to the first `end` literal after it. */
function region(text, start, end) {
    var a = text.indexOf(start);
    if ( a < 0 || text.indexOf(start, a + 1) > -1 ) { return null; }
    var b = text.indexOf(end, a);
    return ( b > a ) ? text.slice(a, b) : null;
}

// ---- the three regions under test -------------------------------------------------------------
var PM_DECL    = '    var processMiddlewares = function(serverInstance, middlewares, controller, action, req, res, next, cb){';
var PM_SRC     = region(ROUTER_SRC, PM_DECL, '\n    init()\n');

var SETUP_DECL = 'controller.setup = function(request, response, next) {';
var SETUP_SRC  = region(ROUTER_SRC, SETUP_DECL, '\n                if ( !self.hasCompletedControlllerSetup )');

var NJ_DECL    = 'function registerUserFilters(env, self, local, localOptions, req, res, _next) {';
var NJ_SRC     = region(NUNJUCKS_SRC, NJ_DECL, '\n}\n');
if ( NJ_SRC ) { NJ_SRC += '\n}'; }

// The 17 controller methods a route middleware is given, and the 15 members `setup.js` is given.
var METHODS = ['checkBundleStatus', 'getConfig', 'getFormsRules', 'getLocales', 'isCacheless', 'isHaltedRequest',
    'isWithCredentials', 'isXMLRequest', 'pauseRequest', 'query', 'redirect', 'render', 'renderJSON',
    'renderWithoutLayout', 'requireController', 'resumeRequest', 'throwError'];
var SETUP_MEMBERS = ['checkBundleStatus', 'engine', 'getConfig', 'getFormsRules', 'getLocales', 'isCacheless',
    'isPopinContext', 'isWithCredentials', 'isXMLRequest', 'redirect', 'render', 'renderJSON',
    'renderWithoutLayout', 'requireController', 'throwError'];

// ---- fixtures: real files, loaded through the real require cache ------------------------------
var TMP        = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b807-')));
var BUNDLE     = path.join(TMP, 'bundle');
var SHARED     = path.join(TMP, 'shared');
var SETUP_FILE = path.join(TMP, 'bundles', 'demo', 'controllers', 'setup.js');

function put(file, lines) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
}
function holdMiddleware(name, extra) {
    return [
        'function HoldMiddleware() {',
        '    var self = this;',
        '    this.hold = async function (req, res, next, done) {',
        '        await req.release;',
        '        self.renderJSON({ from: req.tag });',
        '    };',
        '    this.pass = function (req, res, next, done) {',
        '        (req.trail = req.trail || []).push(' + JSON.stringify(name) + (extra || '') + ');',
        '        done(req, res, next);',
        '    };',
        '}',
        'module.exports = HoldMiddleware;'
    ];
}
var LOCAL_ONLY  = put(path.join(BUNDLE, 'middlewares/localonly/index.js'), holdMiddleware('localonly'));
var SHARED_ONLY = put(path.join(SHARED, 'middlewares/sharedonly/index.js'), holdMiddleware('sharedonly'));
put(path.join(BUNDLE, 'middlewares/twin/index.js'), holdMiddleware('twin', " + ':' + self.sharedHelper()"));
put(path.join(SHARED, 'middlewares/twin/index.js'), [
    'function HoldMiddleware() { this.sharedHelper = function () { return "from the shared twin"; }; }',
    'module.exports = HoldMiddleware;'
]);
var KLASS = put(path.join(BUNDLE, 'middlewares/klass/index.js'), [
    'class HoldMiddleware {',
    '    async hold(req, res, next, done) {',
    '        await req.release;',
    '        this.renderJSON({ from: req.tag });',
    '    }',
    '}',
    'module.exports = HoldMiddleware;'
]);
var SHAPES = put(path.join(BUNDLE, 'middlewares/shapes/index.js'), [
    'function ShapesMiddleware() {',
    '    var self = this;',
    '    var atConstruction = self.getConfig();',
    '    this.redirect = function () { return "own redirect"; };',
    '    this.report = function (req, res, next, done) {',
    '        req.seen = {',
    '            atConstruction : atConstruction,',
    '            isInstance     : (self instanceof ShapesMiddleware),',
    '            fromPrototype  : self.helper(),',
    '            ownRedirect    : self.redirect(),',
    '            providedRender : self.render({ from: req.tag })',
    '        };',
    '        done(req, res, next);',
    '    };',
    '}',
    'ShapesMiddleware.prototype.helper = function () { return "defined on the exported prototype"; };',
    'ShapesMiddleware.prototype.render = function () { return "prototype-level render"; };',
    'module.exports = ShapesMiddleware;'
]);
put(SETUP_FILE, [
    'module.exports = function setup(req, res, next) {',
    '    var self = this;',
    '    self.runs = (self.runs || 0) + 1;',
    '    req.seen = {',
    '        engine     : self.engine,',
    '        throwError : self.throwError,',
    '        runs       : self.runs,',
    '        version    : self.version,',
    '        argCount   : arguments.length,',
    '        later      : function () { return { engine: self.engine, throwError: self.throwError }; }',
    '    };',
    '    if ( !req.release ) { return "sync result of " + req.tag; }',
    '    return (async function () {',
    '        await req.release;',
    '        self.renderJSON({ from: req.tag });',
    '        return "async result of " + req.tag;',
    '    })();',
    '};',
    'module.exports.version = "static-1";'
]);

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

// ---- harness ----------------------------------------------------------------------------------
// Stands in for gina's `_` path helper on the two shapes the regions use: called as a function it
// returns the path string; constructed, an object answering toString() and existsSync().
function PathStub(p) {
    if ( !(this instanceof PathStub) ) { return p; }
    this.p = p;
}
PathStub.prototype.toString   = function () { return this.p; };
PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };

var OWN = 'its own controller';
function noop() {}
function purge() {
    Object.keys(require.cache).forEach(function (k) { if ( k.indexOf(TMP) === 0 ) { delete require.cache[k]; } });
}
function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }
function gate() {
    var release;
    var promise = new Promise(function (resolve) { release = resolve; });
    return { promise: promise, release: release };
}
// One controller per dispatch: its methods are closures over that dispatch's own sink, the shape of
// gina's controller methods (each writes to its own request's response).
function controllerFor(tag, sink) {
    var controller = { engine: { name: 'engine of ' + tag } };
    METHODS.forEach(function (m) {
        controller[m] = function (payload) {
            sink.push({ via: tag, method: m, payload: payload });
            return 'answered by ' + tag;
        };
    });
    return controller;
}
function whereDid(from, ownSink, otherSink) {
    var hit   = function (e) { return e.payload && e.payload.from === from; };
    var own   = ownSink.filter(hit).length;
    var other = otherSink.filter(hit).length;
    if ( own && !other ) { return OWN; }
    if ( !own && other ) { return "the other request's controller"; }
    return own ? 'both controllers' : 'no controller';
}
function compileProcessMiddlewares(isCacheless) {
    var local = { conf: { bundlePath: BUNDLE, sharedPath: SHARED }, isCacheless: isCacheless };
    return new Function('local', '_', 'inherits', 'require', PM_SRC + '\nreturn processMiddlewares;')(
        local, PathStub, inherits, Module.createRequire(ROUTER_SOURCE)
    );
}
/** Two dispatches through one middleware; `interleaved` releases A only after B has entered. */
async function twoDispatches(ref, isCacheless, interleaved) {
    purge();
    var pm = compileProcessMiddlewares(isCacheless);
    var sinkA = [], sinkB = [], errors = [];
    var server = { throwError: function (res, code, msg) { errors.push(code + ' ' + String(msg).split('\n')[0]); } };
    var gA = gate(), gB = gate();
    pm(server, [ref], controllerFor('A', sinkA), 'act', { tag: 'A', release: gA.promise }, {}, noop, noop);
    if ( !interleaved ) { gA.release(); await flush(); }
    pm(server, [ref], controllerFor('B', sinkB), 'act', { tag: 'B', release: gB.promise }, {}, noop, noop);
    if ( interleaved ) { gA.release(); await flush(); }
    gB.release(); await flush();
    return { A: whereDid('A', sinkA, sinkB), B: whereDid('B', sinkB, sinkA), errors: errors };
}
/** One dispatch of a synchronous chain; returns what the chain left behind. */
function oneDispatch(refs, tag) {
    purge();
    var pm = compileProcessMiddlewares(false);
    var sink = [], errors = [], done = [];
    var server = { throwError: function (res, code, msg) { errors.push(code + ' ' + String(msg).split('\n')[0]); } };
    var req = { tag: tag };
    pm(server, refs, controllerFor(tag, sink), 'act', req, {}, noop, function (action) { done.push(action); });
    return { req: req, sink: sink, errors: errors, done: done };
}
function compileSetupWrapper(controller, serverInstance) {
    return new Function('controller', 'serverInstance', 'setupFile', '_', 'require', SETUP_SRC + '\nreturn controller.setup;')(
        controller, serverInstance, SETUP_FILE, PathStub, Module.createRequire(ROUTER_SOURCE)
    );
}
function compileRegisterUserFilters() {
    var quiet = { warn: noop };
    return new Function('fs', 'require', 'console', 'return (' + NJ_SRC + ');')(
        fs, Module.createRequire(NUNJUCKS_SOURCE), quiet
    );
}
/** Runs `setup.js` through the router's wrapper for one request; returns the request and the result. */
function routerSetupRun(tag, sink, release) {
    var controller = controllerFor(tag, sink);
    var server     = { throwError: function serverThrowError() {} };
    controller.setup = compileSetupWrapper(controller, server);
    var req = { tag: tag };
    if ( release ) { req.release = release; }
    var result = controller.setup(req, {}, noop);
    return { req: req, result: result, controller: controller, server: server };
}
function ownKeysOfTheExport() { return Object.keys(require(SETUP_FILE)).sort(); }


describe('01 - extraction controls: the three regions are sliced from the source under test', function () {

    it('CONTROL — processMiddlewares is declared once and the slice reaches its middleware loader', function () {
        assert.ok(PM_SRC, 'the processMiddlewares region must be extractable');
        assert.equal(count(ROUTER_SRC, PM_DECL), 1);
        assert.ok(PM_SRC.indexOf('var Middleware = require(_(filename, true));') > -1, 'the loader line is in the slice');
        assert.ok(PM_SRC.indexOf("return serverInstance.throwError(res, 501, new Error('middleware not found '") > -1);
    });

    it('CONTROL — the router setup wrapper is declared once and the slice loads the setup file', function () {
        assert.ok(SETUP_SRC, 'the setup wrapper region must be extractable');
        assert.equal(count(ROUTER_SRC, SETUP_DECL), 1);
        assert.ok(SETUP_SRC.indexOf('var Setup = require(_(setupFile, true));') > -1);
    });

    it('CONTROL — registerUserFilters is declared once and the slice loads the setup file', function () {
        assert.ok(NJ_SRC, 'the registerUserFilters region must be extractable');
        assert.equal(count(NUNJUCKS_SRC, NJ_DECL), 1);
        assert.ok(NJ_SRC.indexOf('Setup = require(setupFile);') > -1);
        assert.ok(NJ_SRC.indexOf('env._userSetupDone = true;') > -1);
    });
});


describe('02 - route middlewares: each answer reaches the controller of its own request', function () {

    it('CONTROL — serialized (A answers before B enters), module cached', async function () {
        assert.deepEqual(await twoDispatches('middlewares.localonly.hold', false, false), { A: OWN, B: OWN, errors: [] });
    });

    it('a bundle-local middleware, module cached, interleaved: A answers through its own controller', async function () {
        assert.deepEqual(await twoDispatches('middlewares.localonly.hold', false, true), { A: OWN, B: OWN, errors: [] });
    });

    it('a shared-only middleware, module cached, interleaved: A answers through its own controller', async function () {
        assert.deepEqual(await twoDispatches('middlewares.sharedonly.hold', false, true), { A: OWN, B: OWN, errors: [] });
    });

    it('an ES6 class middleware, module cached, interleaved: A answers through its own controller', async function () {
        assert.deepEqual(await twoDispatches('middlewares.klass.hold', false, true), { A: OWN, B: OWN, errors: [] });
    });

    it('CONTROL — dev (the module is evicted on every request), interleaved', async function () {
        assert.deepEqual(await twoDispatches('middlewares.localonly.hold', true, true), { A: OWN, B: OWN, errors: [] });
    });

    it('CONTROL — a bundle-local middleware with a shared twin (a fresh class per request), interleaved', async function () {
        assert.deepEqual(await twoDispatches('middlewares.twin.hold', false, true), { A: OWN, B: OWN, errors: [] });
    });

    it('the cached class is left as its author wrote it: no controller method lands on its prototype', async function () {
        await twoDispatches('middlewares.localonly.hold', false, true);
        var onLocal = METHODS.filter(function (m) { return Object.prototype.hasOwnProperty.call(require(LOCAL_ONLY).prototype, m); });
        assert.deepEqual(onLocal, [], 'bundle-local class');

        await twoDispatches('middlewares.sharedonly.hold', false, true);
        var onShared = METHODS.filter(function (m) { return Object.prototype.hasOwnProperty.call(require(SHARED_ONLY).prototype, m); });
        assert.deepEqual(onShared, [], 'shared-only class');

        await twoDispatches('middlewares.klass.hold', false, true);
        var onClass = METHODS.filter(function (m) { return Object.prototype.hasOwnProperty.call(require(KLASS).prototype, m); });
        assert.deepEqual(onClass, [], 'ES6 class');
    });

    it('a member of the exported prototype named like a provided method is not overwritten on the class', function () {
        oneDispatch(['middlewares.shapes.report'], 'A');
        assert.equal(require(SHAPES).prototype.render(), 'prototype-level render');
    });
});


describe('03 - route middlewares: what the change kept', function () {

    it('CONTROL — the methods are reachable in the constructor body, and belong to the request being built', function () {
        var r = oneDispatch(['middlewares.shapes.report'], 'A');
        assert.deepEqual(r.errors, []);
        assert.equal(r.req.seen.atConstruction, 'answered by A');
    });

    it('CONTROL — an own property wins over a provided method, a provided method over a prototype member', function () {
        var r = oneDispatch(['middlewares.shapes.report'], 'A');
        assert.equal(r.req.seen.ownRedirect, 'own redirect');
        assert.equal(r.req.seen.providedRender, 'answered by A');
        assert.equal(r.sink.filter(function (e) { return e.method === 'redirect'; }).length, 0, 'the controller redirect was not called');
    });

    it('CONTROL — the instance is an instance of the exported class and sees its prototype members', function () {
        var r = oneDispatch(['middlewares.shapes.report'], 'A');
        assert.equal(r.req.seen.isInstance, true);
        assert.equal(r.req.seen.fromPrototype, 'defined on the exported prototype');
    });

    it('CONTROL — a chain of two middlewares runs in order, then hands over to the action once', function () {
        var r = oneDispatch(['middlewares.localonly.pass', 'middlewares.sharedonly.pass'], 'A');
        assert.deepEqual(r.errors, []);
        assert.deepEqual(r.req.trail, ['localonly', 'sharedonly']);
        assert.deepEqual(r.done, ['act']);
    });

    it('CONTROL — a bundle-local middleware still inherits the members of its shared twin', function () {
        var r = oneDispatch(['middlewares.twin.pass'], 'A');
        assert.deepEqual(r.errors, []);
        assert.deepEqual(r.req.trail, ['twin:from the shared twin']);
    });

    it('CONTROL — a middleware name that resolves to no file answers 501 and never reaches the action', function () {
        var r = oneDispatch(['middlewares.absent.pass'], 'A');
        assert.equal(r.errors.length, 1);
        assert.ok(/^501 /.test(r.errors[0]), r.errors[0]);
        assert.deepEqual(r.done, []);
    });
});


describe('04 - setup.js through the router wrapper: a receiver per run', function () {

    it('CONTROL — serialized (A answers before B runs): each answer reaches its own controller', async function () {
        purge();
        var sinkA = [], sinkB = [], gA = gate(), gB = gate();
        routerSetupRun('A', sinkA, gA.promise);
        gA.release(); await flush();
        routerSetupRun('B', sinkB, gB.promise);
        gB.release(); await flush();
        assert.deepEqual({ A: whereDid('A', sinkA, sinkB), B: whereDid('B', sinkB, sinkA) }, { A: OWN, B: OWN });
    });

    it('interleaved on the cached export: A answers through its own controller', async function () {
        purge();
        var sinkA = [], sinkB = [], gA = gate(), gB = gate();
        routerSetupRun('A', sinkA, gA.promise);
        routerSetupRun('B', sinkB, gB.promise);
        gA.release(); await flush();
        gB.release(); await flush();
        assert.deepEqual({ A: whereDid('A', sinkA, sinkB), B: whereDid('B', sinkB, sinkA) }, { A: OWN, B: OWN });
    });

    it('a member read later still belongs to the run that captured `this`', function () {
        purge();
        var a = routerSetupRun('A', []);
        var b = routerSetupRun('B', []);
        assert.equal(a.req.seen.later().engine, a.controller.engine, "A's engine after B ran");
        assert.equal(a.req.seen.later().throwError, a.server.throwError, "A's throwError after B ran");
        assert.equal(b.req.seen.later().engine, b.controller.engine);
    });

    it('state written on `this` stays with its run instead of persisting on the export', function () {
        purge();
        var a = routerSetupRun('A', []);
        var b = routerSetupRun('B', []);
        assert.equal(a.req.seen.runs, 1);
        assert.equal(b.req.seen.runs, 1);
    });

    it('the export is left as its author wrote it, through the router wrapper', function () {
        purge();
        routerSetupRun('A', []);
        assert.deepEqual(ownKeysOfTheExport(), ['version']);
    });

    it('CONTROL — during the run `this` carries the controller engine and the server throwError', function () {
        purge();
        var a = routerSetupRun('A', []);
        assert.equal(a.req.seen.engine, a.controller.engine);
        assert.equal(a.req.seen.throwError, a.server.throwError);
        assert.equal(a.req.seen.argCount, 3);
    });

    it('CONTROL — a static of the export is readable through `this`', function () {
        purge();
        assert.equal(routerSetupRun('A', []).req.seen.version, 'static-1');
    });

    it('CONTROL — the wrapper returns the result of the setup call, a promise for an async one', async function () {
        purge();
        assert.equal(routerSetupRun('A', []).result, 'sync result of A');
        var g = gate();
        var run = routerSetupRun('B', [], g.promise);
        assert.ok(run.result && typeof run.result.then === 'function', 'an async setup hands its promise back');
        g.release();
        assert.equal(await run.result, 'async result of B');
    });

    it('CONTROL — the wrapper runs the setup once per controller', function () {
        purge();
        var a = routerSetupRun('A', []);
        var seen = a.req.seen;
        assert.equal(a.controller.setup(a.req, {}, noop), undefined);
        assert.equal(a.req.seen, seen, 'a second call on the same controller does not run the setup again');
    });
});


describe('05 - setup.js through the nunjucks delegate, and the two call sites on one export', function () {

    function nunjucksRun(tag) {
        var registerUserFilters = compileRegisterUserFilters();
        var env  = { name: 'nunjucks env of ' + tag };
        var self = { throwError: function controllerThrowError() {} };
        var req  = { tag: tag };
        var localOptions = { bundle: 'demo', conf: { bundlesPath: path.join(TMP, 'bundles') } };
        registerUserFilters(env, self, {}, localOptions, req, {}, noop);
        return { env: env, self: self, req: req, again: function () {
            var second = { tag: tag + ' again' };
            registerUserFilters(env, self, {}, localOptions, second, {}, noop);
            return second;
        } };
    }

    it('CONTROL — the run binds `this.engine` to the environment and `this.throwError` to the controller', function () {
        purge();
        var n = nunjucksRun('N');
        assert.equal(n.req.seen.engine, n.env);
        assert.equal(n.req.seen.throwError, n.self.throwError);
        assert.equal(n.req.seen.argCount, 3);
        assert.equal(n.req.seen.version, 'static-1');
    });

    it('CONTROL — the run happens once per environment', function () {
        purge();
        var n = nunjucksRun('N');
        assert.equal(n.env._userSetupDone, true);
        assert.equal(n.again().seen, undefined, 'a second call on the same environment does not run the setup');
    });

    it('the export is left as its author wrote it, through the nunjucks delegate', function () {
        purge();
        nunjucksRun('N');
        assert.deepEqual(ownKeysOfTheExport(), ['version']);
    });

    it('a router run after it does not change what the nunjucks run reads later', function () {
        purge();
        var n = nunjucksRun('N');
        routerSetupRun('A', []);
        assert.equal(n.req.seen.later().engine, n.env);
        assert.equal(n.req.seen.later().throwError, n.self.throwError);
    });

    it('a nunjucks run after it does not change what the router run reads later', function () {
        purge();
        var a = routerSetupRun('A', []);
        nunjucksRun('N');
        assert.equal(a.req.seen.later().engine, a.controller.engine);
        assert.equal(a.req.seen.later().throwError, a.server.throwError);
    });
});


describe('06 - source pins on the three regions, comment-stripped', function () {

    var CLASS_WRITE  = /\bMiddleware\.prototype\.\w+\s*=(?!=)/;
    var EXPORT_WRITE = /\bSetup\.\w+\s*=(?!=)/;
    var pmLive    = stripComments(PM_SRC || '');
    var setupLive = stripComments(SETUP_SRC || '');
    var njLive    = stripComments(NJ_SRC || '');

    it('processMiddlewares writes nothing onto the middleware class', function () {
        assert.ok(pmLive.length > 0);
        assert.equal(CLASS_WRITE.test(pmLive), false);
    });

    it('CONTROL — the strip is load-bearing: the raw region still names a write onto the class', function () {
        assert.equal(CLASS_WRITE.test(PM_SRC || ''), true);
    });

    it('the instance is constructed on a per-request layer inheriting from the class prototype', function () {
        assert.equal(count(pmLive, 'var perRequest = Object.create(Middleware.prototype);'), 1);
        assert.equal(count(pmLive, 'PerRequestMiddleware.prototype = perRequest;'), 1);
        assert.equal(count(pmLive, 'Reflect.construct(Middleware, [], PerRequestMiddleware)'), 1);
    });

    it('the layer carries the 17 methods, each taken from the controller of the request', function () {
        var names = [], re = /\bperRequest\.(\w+)\s*=\s*controller\.(\w+);/g, m;
        while ( (m = re.exec(pmLive)) !== null ) {
            assert.equal(m[1], m[2], 'the layer member and the controller member carry the same name');
            names.push(m[1]);
        }
        assert.deepEqual(names.sort(), METHODS.slice().sort());
    });

    it('the router setup wrapper writes nothing onto the export and runs it on a per-run receiver', function () {
        assert.ok(setupLive.length > 0);
        assert.equal(EXPORT_WRITE.test(setupLive), false);
        assert.equal(count(setupLive, 'var setupContext = Object.create(Setup);'), 1);
        assert.equal(count(setupLive, 'return Setup.apply(setupContext, arguments);'), 1);
    });

    it('the receiver carries the 15 members: the controller ones, and the server throwError', function () {
        var names = [], re = /\bsetupContext\.(\w+)\s*=\s*(controller|serverInstance)\.(\w+);/g, m;
        while ( (m = re.exec(setupLive)) !== null ) {
            assert.equal(m[1], m[3], 'the receiver member and its source carry the same name');
            assert.equal(m[2], ( m[1] === 'throwError' ) ? 'serverInstance' : 'controller', m[1]);
            names.push(m[1]);
        }
        assert.deepEqual(names.sort(), SETUP_MEMBERS.slice().sort());
    });

    it('the nunjucks delegate writes nothing onto the export and runs it on a per-run receiver', function () {
        assert.ok(njLive.length > 0);
        assert.equal(EXPORT_WRITE.test(njLive), false);
        assert.equal(count(njLive, 'var setupContext = Object.create(Setup);'), 1);
        assert.equal(count(njLive, 'setupContext.engine     = env;'), 1);
        assert.equal(count(njLive, 'setupContext.throwError = self.throwError;'), 1);
        assert.equal(count(njLive, 'Setup.apply(setupContext, [req, res, _next]);'), 1);
    });

    it('CONTROL — the strip is load-bearing: both raw setup regions still name a write onto the export', function () {
        assert.equal(EXPORT_WRITE.test(SETUP_SRC || ''), true);
        assert.equal(EXPORT_WRITE.test(NJ_SRC || ''), true);
    });
});
