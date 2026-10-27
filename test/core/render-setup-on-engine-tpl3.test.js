/**
 * #TPL3 — a swig render runs the bundle's `controllers/setup.js` on its engine when that engine
 * has not yet run this `setup.js` module (`runBundleSetupForRender`, core/controller/controller.js),
 * and the router records its own runs on the engine (core/router.js), so an action request still
 * runs it once.
 *
 * The function closes over the controller's `self` and `local`, so its shipped bytes are sliced
 * out of the source and run under `new Function` with stand-ins for those and for `fs`, `_`,
 * `require` and `console` — the shape of router-middleware-per-request-b807.test.js. The booted
 * behaviour (a route middleware's render, dev and prod) is test/integration/container-boot-setup-render-tpl3.test.js.
 *
 *  01 extraction controls
 *  02 outside dev: one run per engine; a recorded run or a recorded absence ends the check without a probe
 *  03 dev: the module is the key — a re-required module runs once, the same module never twice
 *  04 the receiver: the router's 15 members, `throwError` from the server instance, the request's arguments
 *  05 failures: a throw and a rejection are logged and the render goes on; a render setup.js starts does not run it again
 *  06 source pins, comment-stripped: the call site and the router's record
 *
 * Seams: GINA_CONTROLLER_SRC=<file> and GINA_ROUTER_SRC=<file> run every arm against those texts.
 * Red-first against the pre-change bytes (`git show <sha>:<fw>/core/controller/controller.js > <file>`):
 * the extraction controls and every arm that needs the function read RED.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW                = require('../fw');
var CONTROLLER_SOURCE = process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js');
var ROUTER_SOURCE     = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');

var CONTROLLER_SRC = fs.readFileSync(CONTROLLER_SOURCE, 'utf8');
var ROUTER_SRC     = fs.readFileSync(ROUTER_SOURCE, 'utf8');

function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

/**
 * Slices a function expression by brace-matching from its unique declaration (jsdoc.md, the
 * started-flag walk). Returns `{ src, depth, unique }`; `src` is null when the declaration is absent.
 *
 * @inner
 * @param {string} text - the source
 * @param {string} decl - the declaration line, up to and including `function(...)`
 * @returns {{src: (string|null), depth: number, unique: boolean}}
 */
function extractFn(text, decl) {
    var at = text.indexOf(decl);
    if (at < 0) { return { src: null, depth: -1, unique: false }; }
    var unique = text.indexOf(decl, at + 1) === -1;
    var fnAt = text.indexOf('function', at);
    var depth = 0, started = false, i = fnAt;
    for (; i < text.length; i++) {
        var c = text[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return { src: text.slice(fnAt, i), depth: depth, unique: unique };
}

var DECL = '    var runBundleSetupForRender = function(engine, req, res, next) {';
var FN   = extractFn(CONTROLLER_SRC, DECL);

var MEMBERS = [
    'engine', 'getConfig', 'checkBundleStatus', 'getLocales', 'getFormsRules', 'throwError', 'redirect',
    'render', 'renderJSON', 'renderWithoutLayout', 'isXMLRequest', 'isWithCredentials', 'isPopinContext',
    'isCacheless', 'requireController'
];
var SETUP_FILE = '/srv/proj/src/web/controllers/setup.js';

/**
 * A scene: the compiled function bound to stand-ins, and what it did.
 *
 * @inner
 * @param {object} opts - `{ cacheless: boolean, exports: (function|undefined), loadError: (Error|undefined) }`
 *   — `exports` undefined means the setup file is absent; `loadError` makes a present file fail to load
 * @returns {object} `{ run, engine, setExports, probes, requires, warns, self }`
 */
function scene(opts) {
    var probes = [], requires = [], warns = [];
    var current = { exports: opts.exports, loadError: opts.loadError };
    var self = {
        isCacheless: function () { return !!opts.cacheless; },
        serverInstance: { throwError: function serverThrowError() {} },
        throwError: function controllerThrowError() {}
    };
    MEMBERS.forEach(function (m) {
        if (m === 'engine' || m === 'throwError' || m === 'isCacheless') { return; }
        self[m] = function () { return m; };
    });
    var local = { options: { conf: { bundlesPath: '/srv/proj/src' }, bundle: 'web' } };
    var fsStub = { existsSync: function (p) { probes.push(p); return typeof(current.exports) != 'undefined' || !!current.loadError; } };
    var pathStub = function (p) { return p; };
    var requireStub = function (p) {
        requires.push(p);
        if (current.loadError) { throw current.loadError; }
        if (typeof(current.exports) == 'undefined') { throw new Error('Cannot find module ' + p); }
        return current.exports;
    };
    var consoleStub = { warn: function (m) { warns.push(String(m)); } };
    var fn = new Function('self', 'local', 'fs', '_', 'require', 'console', 'return (' + FN.src + ');')(
        self, local, fsStub, pathStub, requireStub, consoleStub
    );
    var engine = { setFilter: function () {} };
    return {
        // run() renders on the scene's engine; run(x) on x, whatever x is (null included)
        run: function (eng) { return fn(arguments.length ? eng : engine, { tag: 'req' }, { tag: 'res' }, function next() {}); },
        engine: engine,
        setExports: function (e) { current.exports = e; },
        probes: probes, requires: requires, warns: warns, self: self
    };
}

/** A setup.js export that records each run: its receiver and arguments. */
function recordingSetup(sink) {
    var Setup = function () { sink.push({ self: this, args: Array.prototype.slice.call(arguments) }); };
    Setup.version = 'static-1';
    return Setup;
}


describe('01 - extraction controls', function () {

    it('CONTROL — the function is declared once and its body is sliced with balanced braces', function () {
        assert.ok(FN.src, 'the runBundleSetupForRender declaration must be found in ' + CONTROLLER_SOURCE);
        assert.equal(FN.unique, true, 'declared exactly once');
        assert.equal(FN.depth, 0, 'balanced braces');
        assert.ok(FN.src.indexOf("opts.conf.bundlesPath +'/'+ opts.bundle +'/controllers/setup.js'") > -1, 'the slice reaches the file path');
        assert.ok(FN.src.indexOf('Setup.apply(setupContext, [req, res, next])') > -1, 'the slice reaches the call');
    });
});


describe('02 - outside dev: one run per engine', function () {

    it('a present setup.js runs once and the module is recorded on the engine', function () {
        var runs = [], Setup = recordingSetup(runs), s = scene({ cacheless: false, exports: Setup });
        s.run();
        assert.equal(runs.length, 1);
        assert.equal(s.engine._ginaSetupFn, Setup);
        assert.deepEqual(s.probes, [SETUP_FILE]);
    });

    it('a second render on the same engine neither probes the file nor runs setup.js', function () {
        var runs = [], s = scene({ cacheless: false, exports: recordingSetup(runs) });
        s.run(); s.run(); s.run();
        assert.equal(runs.length, 1);
        assert.equal(s.probes.length, 1);
        assert.equal(s.requires.length, 1);
    });

    it('an absent setup.js is recorded on the engine, and the next render does not probe again', function () {
        var s = scene({ cacheless: false, exports: undefined });
        s.run(); s.run();
        assert.equal(s.engine._ginaSetupAbsent, true);
        assert.equal(s.probes.length, 1);
        assert.equal(s.requires.length, 0);
    });

    it('an engine the router already ran setup.js on is neither probed nor run again', function () {
        var runs = [], Setup = recordingSetup(runs), s = scene({ cacheless: false, exports: Setup });
        s.engine._ginaSetupFn = Setup;
        s.run();
        assert.equal(runs.length, 0);
        assert.equal(s.probes.length, 0);
    });

    it('a different engine (another template root) runs setup.js once more', function () {
        var runs = [], s = scene({ cacheless: false, exports: recordingSetup(runs) });
        s.run();
        s.run({ setFilter: function () {} });
        assert.equal(runs.length, 2);
    });

    it('CONTROL — no engine to register on (none, a bundle without templates, a non-swig object): nothing is probed or run', function () {
        var runs = [], s = scene({ cacheless: false, exports: recordingSetup(runs) });
        [undefined, null, {}, { name: 'no setFilter' }].forEach(function (e) { s.run(e); });
        assert.equal(runs.length, 0);
        assert.equal(s.probes.length, 0);
    });
});


describe('03 - dev: the module is the key', function () {

    it('the same module on later renders: one run, a probe per render', function () {
        var runs = [], s = scene({ cacheless: true, exports: recordingSetup(runs) });
        s.run(); s.run();
        assert.equal(runs.length, 1);
        assert.equal(s.probes.length, 2);
    });

    it('a re-required module (a new export) runs once more', function () {
        var runs = [], s = scene({ cacheless: true, exports: recordingSetup(runs) });
        s.run();
        var second = recordingSetup(runs);
        s.setExports(second);
        s.run(); s.run();
        assert.equal(runs.length, 2);
        assert.equal(s.engine._ginaSetupFn, second);
    });

    it('an absent file is not recorded as absent: a file added later is picked up', function () {
        var runs = [], s = scene({ cacheless: true, exports: undefined });
        s.run();
        assert.equal(s.engine._ginaSetupAbsent, undefined);
        s.setExports(recordingSetup(runs));
        s.run();
        assert.equal(runs.length, 1);
    });
});


describe('04 - the receiver', function () {

    it('the run gets the router\'s 15 members: the controller\'s, the server throwError, the render\'s engine', function () {
        var runs = [], s = scene({ cacheless: false, exports: recordingSetup(runs) });
        s.run();
        var r = runs[0].self;
        MEMBERS.forEach(function (m) { assert.notEqual(typeof(r[m]), 'undefined', m); });
        assert.equal(r.engine, s.engine);
        assert.equal(r.throwError, s.self.serverInstance.throwError);
        assert.equal(r.getConfig, s.self.getConfig);
        assert.equal(r.requireController, s.self.requireController);
    });

    it('the receiver is a fresh object inheriting from the export; nothing is written onto the export', function () {
        var runs = [], Setup = recordingSetup(runs), s = scene({ cacheless: true, exports: Setup });
        var keysBefore = Object.keys(Setup).sort();
        s.run();
        assert.equal(Object.getPrototypeOf(runs[0].self), Setup);
        assert.equal(runs[0].self.version, 'static-1', 'a static of the export reads through the receiver');
        assert.deepEqual(Object.keys(Setup).sort(), keysBefore);
    });

    it('the run receives the request, the response and next', function () {
        var runs = [], s = scene({ cacheless: false, exports: recordingSetup(runs) });
        s.run();
        assert.equal(runs[0].args.length, 3);
        assert.equal(runs[0].args[0].tag, 'req');
        assert.equal(runs[0].args[1].tag, 'res');
        assert.equal(typeof(runs[0].args[2]), 'function');
    });
});


describe('05 - failures', function () {

    it('a throw is logged with the bundle name and the render goes on', function () {
        var s = scene({ cacheless: false, exports: function () { throw new Error('boom'); } });
        assert.doesNotThrow(function () { s.run(); });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /\[ web \].*threw during a render: boom/);
    });

    it('a rejection is logged, and handled (no unhandled rejection)', async function () {
        var unhandled = [];
        var onUnhandled = function (r) { unhandled.push(r); };
        process.on('unhandledRejection', onUnhandled);
        try {
            var s = scene({ cacheless: false, exports: function () { return Promise.reject(new Error('late')); } });
            s.run();
            await new Promise(function (r) { setImmediate(r); });
            await new Promise(function (r) { setImmediate(r); });
            assert.equal(s.warns.length, 1);
            assert.match(s.warns[0], /rejected during a render: late/);
            assert.deepEqual(unhandled, []);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('a present file that fails to load is logged, nothing runs, and the engine is not recorded', function () {
        var s = scene({ cacheless: false, loadError: new SyntaxError('Unexpected token') });
        assert.doesNotThrow(function () { s.run(); });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /\[ web \].*could not be loaded for a render: Unexpected token/);
        assert.equal(s.engine._ginaSetupFn, undefined);
        assert.equal(s.engine._ginaSetupAbsent, undefined);
    });

    it('CONTROL — an absent file is not a load failure: nothing is logged', function () {
        var s = scene({ cacheless: false, exports: undefined });
        s.run();
        assert.deepEqual(s.warns, []);
    });

    it('a render setup.js starts itself does not run setup.js again', function () {
        var runs = 0, s;
        var Setup = function () { runs++; s.run(); };
        s = scene({ cacheless: true, exports: Setup });
        s.run();
        assert.equal(runs, 1);
    });
});


describe('06 - source pins, comment-stripped', function () {

    var ctlLive    = stripComments(CONTROLLER_SRC);
    var routerLive = stripComments(ROUTER_SRC);

    it('the render calls it once, on the swig branch only, after the delegate is chosen and before the dispatch', function () {
        var call = 'runBundleSetupForRender(local._swigEngine, local.req, local.res, local.next);';
        assert.equal(count(ctlLive, call), 1);
        var at       = ctlLive.indexOf(call);
        var guard    = ctlLive.lastIndexOf("if ( _engine !== 'nunjucks' ) {", at);
        var chosen   = ctlLive.lastIndexOf("_delegate = _swigAsync ? '/controller.render-swig-async' : '/controller.render-swig';", at);
        var dispatch = ctlLive.indexOf('return require( _(__dirname + _delegate, true) )', at);
        assert.ok(guard > -1 && at - guard < 120, 'the call sits in the nunjucks-excluding guard');
        assert.ok(chosen > -1, 'the delegate is chosen before the call');
        assert.ok(dispatch > at, 'the delegate is dispatched after the call');
    });

    it('CONTROL — the strip is load-bearing: the raw source also names the call in the function\'s own @example', function () {
        assert.equal(count(CONTROLLER_SRC, 'runBundleSetupForRender(local._swigEngine, local.req, local.res, local.next);'), 2);
    });

    it('the router records its run on the engine before its call', function () {
        var mark  = routerLive.indexOf('controller.engine._ginaSetupFn = Setup;');
        var apply = routerLive.indexOf('return Setup.apply(setupContext, arguments);');
        assert.ok(mark > -1, 'the router records the module on the engine');
        assert.equal(count(routerLive, 'controller.engine._ginaSetupFn = Setup;'), 1);
        assert.ok(apply > mark && apply - mark < 200, 'the record comes right before the call');
    });

    it('the function writes nothing onto the export', function () {
        assert.ok(FN.src);
        assert.equal(/\bSetup\.\w+\s*=(?!=)/.test(stripComments(FN.src)), false);
    });
});
