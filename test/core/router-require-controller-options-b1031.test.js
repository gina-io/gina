'use strict';
/**
 * #B1031 — `requireController(namespace)` without `options` builds the controller with the
 * options of the request being served.
 *
 * The function read `options.controlRequired` with no guard, before its try, so a call without
 * `options` (or with `null`) threw `TypeError: Cannot read properties of undefined (reading
 * 'controlRequired')`, although its JSDoc marks `[options]` optional. A route middleware and a
 * bundle's `setup.js` are handed `requireController` but no `_options` of their own, so in them
 * the method threw however it was called. An absent `options` now defaults to the request's
 * options, which `route()` keeps as `requestOptions` just above the function: the object the
 * routed controller is built with, and the one an action passes as `self._options`. A call that
 * passes options still uses them as given.
 *
 *  01 extraction controls — the three regions are sliced from the source under test.
 *  02 the REAL `requireController` bytes compiled with their closure inputs (the #B1126 test's
 *     extraction), over a super controller that records what each instance was built and wired
 *     with: an omitted, `undefined` or `null` `options` builds and wires the controller with the
 *     request's options and records the bookkeeping there, and so does a call from a required
 *     controller. CONTROL: options passed explicitly are used as given.
 *  03 a route middleware through the REAL `processMiddlewares` bytes and a `setup.js` through the
 *     REAL `controller.setup` wrapper bytes (the #B807 test's extraction): their receiver has no
 *     `_options` (CONTROL), and `self.requireController(ns)` and
 *     `self.requireController(ns, self._options)` both build a controller wired with the request's
 *     options.
 *  04 source pins, comment-stripped, each with the strip's own control: the default comes before
 *     the bookkeeping, and the alias is assigned once in `route()`, after the routed controller is
 *     built and before the function, with no assignment to `options` in between.
 *
 * Seam: GINA_ROUTER_SRC=<absolute file> runs every arm against that text. Red-first against the
 * pre-change bytes (`git show <sha>:<fw>/core/router.js > <file>`): the arms that pin the change
 * read RED, the arms labelled CONTROL pin what it kept and stay GREEN. Nothing here waits on a
 * callback or a timer, so a regression fails and never hangs.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var Module = require('module');

var FW            = require('../fw');
var ROUTER_SOURCE = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var inherits      = require(path.join(FW, 'lib/inherits/src/main'));
var ROUTER_SRC    = fs.readFileSync(ROUTER_SOURCE, 'utf8');

// realpath: on macOS os.tmpdir() is a symlink, and require-cache keys are real paths
var TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1031-')));
var ENV_BEFORE = process.env.NODE_ENV_IS_DEV;

after(function () {
    Object.keys(require.cache).forEach(function (k) { if ( k.indexOf(TMP) === 0 ) { delete require.cache[k]; } });
    fs.rmSync(TMP, { recursive: true, force: true });
    if ( typeof(ENV_BEFORE) == 'undefined' ) { delete process.env.NODE_ENV_IS_DEV; } else { process.env.NODE_ENV_IS_DEV = ENV_BEFORE; }
});

/** Index of the brace closing the one opened at `open`, skipping strings and comments. */
function matchBrace(src, open) {
    var depth = 0, i, c, q;
    for (i = open; i < src.length; i++) {
        c = src[i];
        if ( c === '/' && src[i + 1] === '/' ) { i = src.indexOf('\n', i); if ( i < 0 ) { return -1; } continue; }
        if ( c === '/' && src[i + 1] === '*' ) { i = src.indexOf('*/', i + 2) + 1; if ( i <= 0 ) { return -1; } continue; }
        if ( c === '\'' || c === '"' || c === '`' ) {
            q = c;
            for (i++; i < src.length && src[i] !== q; i++) { if ( src[i] === '\\' ) { i++; } }
            continue;
        }
        if ( c === '{' ) { depth++; }
        else if ( c === '}' ) { depth--; if ( depth === 0 ) { return i; } }
    }
    return -1;
}

/** Slices the function expression assigned by the unique `start` literal, or null. */
function sliceFn(src, start) {
    var a = src.indexOf(start);
    if ( a < 0 || src.indexOf(start, a + 1) > -1 ) { return null; }
    var close = matchBrace(src, src.indexOf('{', a + start.length - 1));
    if ( close < 0 ) { return null; }
    return src.slice(a, close + 1) + ( /^\s*;/.test(src.slice(close + 1, close + 8)) ? ';' : '' );
}

/** Slices `text` from the unique `start` literal up to the first `end` literal after it, or null. */
function region(text, start, end) {
    var a = text.indexOf(start);
    if ( a < 0 || text.indexOf(start, a + 1) > -1 ) { return null; }
    var b = text.indexOf(end, a);
    if ( b < 0 ) { return null; }
    return text.slice(a, b);
}

function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

var RC_DECL    = 'var requireController = function (namespace, options) {';
var RC_SRC     = sliceFn(ROUTER_SRC, RC_DECL);
var PM_DECL    = '    var processMiddlewares = function(serverInstance, middlewares, controller, action, req, res, next, cb){';
var PM_SRC     = region(ROUTER_SRC, PM_DECL, '\n    init()\n');
var SETUP_DECL = 'controller.setup = function(request, response, next) {';
var SETUP_SRC  = region(ROUTER_SRC, SETUP_DECL, '\n                if ( !self.hasCompletedControlllerSetup )');

// The body a middleware method and a setup.js share: what the receiver has, then the two calls.
var RECEIVER_BODY = [
    '    req.seen.selfOptions = typeof self._options;',
    '    try { req.seen.withSelfOptions = self.requireController("billing", self._options); }',
    '    catch (e) { req.seen.withSelfOptions = e; }',
    '    try { req.seen.omitted = self.requireController("billing"); }',
    '    catch (e) { req.seen.omitted = e; }'
];

/**
 * A bundle tree in TMP: a super controller behind an `index.js` that mirrors the framework's own
 * gate and records what each instance was built and wired with, a `billing` namespace
 * controller, a route middleware and a `setup.js` running RECEIVER_BODY, and a long-lived parent.
 *
 * @inner
 * @returns {object} the tree's paths
 */
function makeTree() {
    var dir  = path.join(TMP, 'tree');
    var core = path.join(dir, 'core', 'controller');
    var ctrl = path.join(dir, 'bundles', 'b', 'controllers');
    fs.mkdirSync(core, { recursive: true });
    fs.mkdirSync(ctrl, { recursive: true });
    fs.mkdirSync(path.join(dir, 'bundle', 'middlewares', 'probe'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(core, 'index.js'),
        "var isCacheless = ( /^false$/i.test(process.env.NODE_ENV_IS_DEV) ) ? false : true;\n"
      + "if (isCacheless) { delete require.cache[require.resolve('./controller')]; }\n"
      + "module.exports = require('./controller');\n");
    fs.writeFileSync(path.join(core, 'controller.js'),
        "function SuperController(options) { this.builtWith = options; }\n"
      + "SuperController.prototype.setOptions = function (req, res, next, options) { this.wiredWith = options; this.wiredReq = req; };\n"
      + "module.exports = SuperController;\n");
    fs.writeFileSync(path.join(ctrl, 'controller.billing.js'),
        "function BillingController() { this.answer = function () { return 'billing'; }; }\n"
      + "module.exports = BillingController;\n");
    fs.writeFileSync(path.join(dir, 'bundle', 'middlewares', 'probe', 'index.js'),
        ['function ProbeMiddleware() {', '  var self = this;', '  this.run = function (req, res, next, done) {']
            .concat(RECEIVER_BODY, ['    done(req, res, next);', '  };', '}', 'module.exports = ProbeMiddleware;'])
            .join('\n') + '\n');
    fs.writeFileSync(path.join(ctrl, 'setup.js'),
        ['module.exports = function (req, res, next) {', '  var self = this;'].concat(RECEIVER_BODY, ['};']).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'parent.js'), "module.exports = { require: require, module: module };\n");
    return {
        dir: dir, core: path.join(dir, 'core'), bundles: path.join(dir, 'bundles'),
        index: path.join(core, 'index.js'), bundle: path.join(dir, 'bundle'), shared: path.join(dir, 'shared'),
        setupFile: path.join(ctrl, 'setup.js')
    };
}
var TREE = makeTree();

/**
 * Compiles the REAL requireController bytes with every closure input passed in, `requestOptions`
 * among them (route() assigns it above the function, outside the slice).
 *
 * @inner
 * @param {object} requestOptions - the options of the request being served
 * @param {object} request        - the request the controllers are wired to
 * @returns {{rc: function, throwErrors: string[]}}
 */
function compile(requestOptions, request) {
    process.env.NODE_ENV_IS_DEV = 'false';
    var parent = require(path.join(TREE.dir, 'parent.js'));
    // router.js requires the super controller once, at module load
    parent.require(TREE.index);
    var throwErrors = [];
    var rc = new Function('_isDev', 'getPath', 'getContext', '_', 'inherits', 'require', 'serverInstance',
        'request', 'response', 'next', 'pruneDeadModuleChildren', 'requestOptions', RC_SRC + '\nreturn requireController;')(
        false,
        function () { return { core: TREE.core }; },
        function () {
            return { Config: { instance: { bundle: 'b', env: 'prod', scope: 'production',
                Env: { getConf: function () { return { bundlesPath: TREE.bundles }; } } } } };
        },
        function (p) { return path.resolve(p); },
        inherits,
        parent.require,
        { throwError: function (res, code, err) { throwErrors.push(code + ' ' + String(err && err.message || err)); } },
        request, {}, function () {},
        function () {},
        requestOptions
    );
    return { rc: rc, throwErrors: throwErrors };
}

/** Runs `fn`, returning `{ value }` or `{ threw: '<Class>: <message>' }`. */
function call(fn) {
    try { return { value: fn() }; }
    catch (e) { return { threw: e.constructor.name + ': ' + e.message }; }
}

/** Asserts `c` is a billing controller built and wired with `opts` for `request`. */
function assertWired(c, opts, request, what) {
    assert.ok(!(c instanceof Error), what + ' threw: ' + (c && c.message));
    assert.ok(c && typeof c.answer === 'function', what + ' must return the billing controller');
    assert.equal(c.answer(), 'billing');
    assert.ok(c.builtWith === opts, what + ': built with the request options');
    assert.ok(c.wiredWith === opts, what + ': wired (setOptions) with the request options');
    assert.ok(c.wiredReq === request, what + ': wired to the request being served');
}

// gina's `_` on the two shapes the receiver regions use: called, the path string; constructed,
// an object answering toString() and existsSync().
function PathStub(p) {
    if ( !(this instanceof PathStub) ) { return p; }
    this.p = p;
}
PathStub.prototype.toString   = function () { return this.p; };
PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };

var MEMBERS = ['checkBundleStatus', 'getConfig', 'getFormsRules', 'getLocales', 'isCacheless', 'isHaltedRequest',
    'isWithCredentials', 'isXMLRequest', 'isPopinContext', 'pauseRequest', 'query', 'redirect', 'render',
    'renderJSON', 'renderWithoutLayout', 'resumeRequest', 'throwError'];

/** The routed controller a receiver region is handed: no-op members and the compiled requireController. */
function routedWith(rc) {
    var c = { engine: {} };
    MEMBERS.forEach(function (m) { c[m] = function () {}; });
    c.requireController = rc;
    return c;
}

function purgeTree() {
    Object.keys(require.cache).forEach(function (k) {
        if ( k.indexOf(TREE.bundle) === 0 || k === TREE.setupFile ) { delete require.cache[k]; }
    });
}

/** One dispatch through the REAL processMiddlewares bytes; returns what the middleware saw. */
function throughMiddleware(rc) {
    purgeTree();
    var pm = new Function('local', '_', 'inherits', 'require', PM_SRC + '\nreturn processMiddlewares;')(
        { conf: { bundlePath: TREE.bundle, sharedPath: TREE.shared }, isCacheless: false },
        PathStub, inherits, Module.createRequire(ROUTER_SOURCE));
    var errors = [], done = [];
    var server = { throwError: function (res, code, msg) { errors.push(code + ' ' + String(msg).split('\n')[0]); } };
    var req = { seen: {} };
    pm(server, ['middlewares.probe.run'], routedWith(rc), 'act', req, {}, function () {}, function (action) { done.push(action); });
    return { seen: req.seen, errors: errors, done: done };
}

/** One run of `setup.js` through the REAL controller.setup wrapper bytes; returns what it saw. */
function throughSetup(rc) {
    purgeTree();
    var routed = routedWith(rc);
    var errors = [];
    var server = { throwError: function (res, code, msg) { errors.push(code + ' ' + String(msg).split('\n')[0]); } };
    routed.setup = new Function('controller', 'serverInstance', 'setupFile', '_', 'require', SETUP_SRC + '\nreturn controller.setup;')(
        routed, server, TREE.setupFile, PathStub, Module.createRequire(ROUTER_SOURCE));
    var req = { seen: {} };
    routed.setup(req, {}, function () {});
    return { seen: req.seen, errors: errors };
}

describe('01 - extraction controls', function () {

    it('the requireController region is sliced whole from the source under test', function () {
        assert.ok(RC_SRC, 'the requireController region must be extractable');
        assert.equal(count(RC_SRC, 'options.controlRequired.push(ctrlInfo);'), 1, 'the bookkeeping is in the slice');
        assert.equal(count(RC_SRC, 'controller.requireController = requireController;'), 1, 'the slice reaches its own end');
    });

    it('the processMiddlewares region hands the middleware requireController', function () {
        assert.ok(PM_SRC, 'the processMiddlewares region must be extractable');
        assert.equal(count(PM_SRC, 'perRequest.requireController   = controller.requireController;'), 1);
    });

    it('the controller.setup wrapper region hands setup.js requireController', function () {
        assert.ok(SETUP_SRC, 'the setup wrapper region must be extractable');
        assert.equal(count(SETUP_SRC, 'setupContext.requireController   = controller.requireController;'), 1);
    });
});

describe('02 - requireController without options, real bytes', function () {

    it('an omitted options builds and wires the controller with the request options', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var h = compile(reqOpts, request);
        var r = call(function () { return h.rc('billing'); });
        assert.equal(r.threw, undefined, 'requireController(namespace) must not throw: ' + r.threw);
        assertWired(r.value, reqOpts, request, 'requireController(namespace)');
        assert.equal(reqOpts.controlRequired && reqOpts.controlRequired.length, 1, 'the bookkeeping is on the request options');
        assert.deepEqual(h.throwErrors, []);
    });

    it('an undefined options does the same', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var h = compile(reqOpts, request);
        var r = call(function () { return h.rc('billing', undefined); });
        assert.equal(r.threw, undefined, 'requireController(namespace, undefined) must not throw: ' + r.threw);
        assertWired(r.value, reqOpts, request, 'requireController(namespace, undefined)');
        assert.equal(reqOpts.controlRequired && reqOpts.controlRequired.length, 1);
        assert.deepEqual(h.throwErrors, []);
    });

    it('a null options does the same', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var h = compile(reqOpts, request);
        var r = call(function () { return h.rc('billing', null); });
        assert.equal(r.threw, undefined, 'requireController(namespace, null) must not throw: ' + r.threw);
        assertWired(r.value, reqOpts, request, 'requireController(namespace, null)');
        assert.equal(reqOpts.controlRequired && reqOpts.controlRequired.length, 1);
        assert.deepEqual(h.throwErrors, []);
    });

    it('a required controller calling requireController without options gets the request options too', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var h = compile(reqOpts, request);
        var first = h.rc('billing', reqOpts);
        var r = call(function () { return first.requireController('billing'); });
        assert.equal(r.threw, undefined, 'the nested call must not throw: ' + r.threw);
        assertWired(r.value, reqOpts, request, 'the nested requireController(namespace)');
        assert.equal(reqOpts.controlRequired.length, 2, 'both calls recorded on the request options');
        assert.deepEqual(h.throwErrors, []);
    });

    it('CONTROL: options passed explicitly are used as given', function () {
        var reqOpts = { rule: 'r@b' }, own = { rule: 'own@b' }, request = { tag: 'request' };
        var h = compile(reqOpts, request);
        var mine = h.rc('billing', own);
        assertWired(mine, own, request, 'requireController(namespace, own)');
        assert.equal(own.controlRequired.length, 1, 'the bookkeeping is on the options passed');
        assert.equal(typeof reqOpts.controlRequired, 'undefined', 'the request options are left alone');
        var asAction = h.rc('billing', reqOpts);
        assertWired(asAction, reqOpts, request, 'requireController(namespace, self._options)');
        assert.deepEqual(h.throwErrors, []);
    });
});

describe('03 - a route middleware and setup.js, real receiver bytes', function () {

    it('CONTROL: a middleware receiver has no _options', function () {
        var h = compile({ rule: 'r@b' }, { tag: 'request' });
        var m = throughMiddleware(h.rc);
        assert.equal(m.seen.selfOptions, 'undefined');
        assert.deepEqual(m.done, ['act'], 'the chain reached the action');
        assert.deepEqual(m.errors, []);
    });

    it('a middleware: requireController(namespace) is wired with the request options', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var m = throughMiddleware(compile(reqOpts, request).rc);
        assertWired(m.seen.omitted, reqOpts, request, 'self.requireController(namespace) in a middleware');
    });

    it('a middleware: requireController(namespace, self._options) is wired with the request options', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var m = throughMiddleware(compile(reqOpts, request).rc);
        assertWired(m.seen.withSelfOptions, reqOpts, request, 'self.requireController(namespace, self._options) in a middleware');
    });

    it('CONTROL: a setup.js receiver has no _options', function () {
        var h = compile({ rule: 'r@b' }, { tag: 'request' });
        var s = throughSetup(h.rc);
        assert.equal(s.seen.selfOptions, 'undefined');
        assert.deepEqual(s.errors, []);
    });

    it('setup.js: requireController(namespace) is wired with the request options', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var s = throughSetup(compile(reqOpts, request).rc);
        assertWired(s.seen.omitted, reqOpts, request, 'self.requireController(namespace) in setup.js');
    });

    it('setup.js: requireController(namespace, self._options) is wired with the request options', function () {
        var reqOpts = { rule: 'r@b' }, request = { tag: 'request' };
        var s = throughSetup(compile(reqOpts, request).rc);
        assertWired(s.seen.withSelfOptions, reqOpts, request, 'self.requireController(namespace, self._options) in setup.js');
    });
});

describe('04 - source pins, comment-stripped', function () {

    var DEFAULT = 'options = requestOptions;';
    var ALIAS   = 'var requestOptions = options;';

    it('the default to the request options comes before the bookkeeping', function () {
        var live = stripComments(RC_SRC || '');
        var at = live.indexOf(DEFAULT);
        assert.ok(at > -1, 'the slice assigns the request options to an absent options');
        assert.ok(at < live.indexOf('options.controlRequired'), 'and does so before the first options.controlRequired read');
        assert.ok(/if \( typeof\(options\) == 'undefined' \|\| options === null \) \{\s*options = requestOptions;/.test(live),
            'only when options is undefined or null');
    });

    it('the alias is assigned once in route(), after the routed controller is built and before the function', function () {
        var live  = stripComments(ROUTER_SRC);
        var route = live.indexOf('this.route = function(request, response, next, params) {');
        var built = live.indexOf('var controller  = new Controller(options);');
        var alias = live.indexOf(ALIAS);
        var fn    = live.indexOf(RC_DECL);
        assert.equal(count(live, ALIAS), 1, 'one alias');
        assert.ok(route > -1 && built > route && alias > built && fn > alias, 'route() < new Controller(options) < alias < requireController');
        var between = live.slice(built, fn);
        assert.equal((between.match(/(^|[^.\w])options\s*=[^=]/g) || []).length, 0, 'options is not assigned between the routed controller and the function');
    });

    it('CONTROL: the strip removes comment lines and keeps the code they sit beside', function () {
        assert.ok(count(RC_SRC || '', '//') > 0, 'the raw slice carries comment lines');
        assert.equal(count(stripComments(RC_SRC || ''), "// replaced: per-request process.env lookup"), 0, 'a comment line is stripped');
        assert.equal(count(stripComments(RC_SRC || ''), 'options.controlRequired.push(ctrlInfo);'), 1, 'the code beside it stays');
    });
});
