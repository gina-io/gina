/**
 * core/controller/controller.js — the per-bundle swig engine carries the `getOptions()` accessor (#B538)
 *
 * `controller.js` installs `swig.getOptions` on the swig MODULE once per request — a closure over
 * that request's `local._swigOptions` — and until #B514 `self.engine` WAS the module, so the
 * documented call shape `self.engine.compile(tpl, self.engine.getOptions())(data)` resolved. #B514
 * pointed `self.engine` at a per-bundle `new swig.Swig()` instance, which never received the
 * accessor; the #B535 bridge carries the three registration setters, not methods. Result:
 * `TypeError: self.engine.getOptions is not a function`, thrown on the accessor before any compile.
 *
 * The accessor cannot be copied from the module: that closure is per-request and the instance is
 * per-bundle, shared by every request to the bundle. `exposeOptionsOnEngine` gives the instance
 * its OWN accessor — a snapshot of the options it was built with, taken once at mint, handed back
 * as a fresh `JSON.clone` per call. The behaviour arms drive the REAL fork through the functions
 * extracted from controller.js (free identifiers: `process`, injected as a fake so the registry is
 * isolated, and gina's own `JSON.clone`, installed below exactly as helpers/prototypes does). A
 * frozen verbatim copy of the PRE-fix `getDefaultSwigEngine` is driven first through the same
 * harness and must reproduce the known regression, or no later reading is trusted.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var os     = require('os');

// gina's own deep copy — the global the framework installs via helpers/prototypes. NOT a
// JSON.parse(JSON.stringify()) stand-in: that one strips the loader's functions, this one keeps them.
JSON.clone = require('../../utils/prototypes.json_clone');

var FW   = require('../fw');
var SRC  = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var swig = require('@rhinostone/swig');

/** Extracts a top-level `function <name>(...) { ... }` from the controller source by brace matching. */
function extractFunction(src, name) {
    var m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{'));
    if (!m) { return null; }
    var start = m.index + 1, i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
    }
    return null;
}

/** Compiles the extracted functions with a fake `process`, returning callable references. */
function load(fnSources) {
    var fakeProcess = { gina: {} };
    var body = fnSources.join('\n') + '\nreturn {'
        + ' getDefaultSwigEngine: typeof getDefaultSwigEngine === "function" ? getDefaultSwigEngine : null,'
        + ' bridgeRegistrationsToModule: typeof bridgeRegistrationsToModule === "function" ? bridgeRegistrationsToModule : null,'
        + ' exposeOptionsOnEngine: typeof exposeOptionsOnEngine === "function" ? exposeOptionsOnEngine : null };';
    return { api: new Function('process', body)(fakeProcess), process: fakeProcess };
}

// The pre-fix function, verbatim from the tree at 2929ab3de (post-#B535) — the known-behaviour control.
var PRE_FIX_GET_DEFAULT_SWIG_ENGINE = [
    'function getDefaultSwigEngine(swigMod, templateRoot, opts) {',
    '    if (!process.gina._swigDefaultEngines) {',
    '        process.gina._swigDefaultEngines = Object.create(null);',
    '    }',
    '    // Instances are bound to the module that built them — drop the whole',
    '    // registry on a dev-mode swig hot-swap (mirrors _swigEnginesOwner).',
    '    if (process.gina._swigDefaultEnginesOwner !== swigMod) {',
    '        process.gina._swigDefaultEngines      = Object.create(null);',
    '        process.gina._swigDefaultEnginesOwner = swigMod;',
    '    }',
    '    if (!process.gina._swigDefaultEngines[templateRoot]) {',
    '        process.gina._swigDefaultEngines[templateRoot] = new swigMod.Swig(opts);',
    '        // #B535 — registrations made on this instance must still reach the module.',
    '        bridgeRegistrationsToModule(process.gina._swigDefaultEngines[templateRoot], swigMod);',
    '    }',
    '    return process.gina._swigDefaultEngines[templateRoot];',
    '}'
].join('\n');

/** A private stand-in for the swig module: a fresh instance that ALSO exposes the `.Swig` constructor, as the module does. */
function moduleStandIn() { var m = new swig.Swig({}); m.Swig = swig.Swig; return m; }

/** The options object controller.js builds for a bundle: autoescape from settings, cache off, a confined fs loader. */
function bundleOpts(autoescape) {
    return { autoescape: autoescape === true, cache: false, loader: swig.loaders.fs(os.tmpdir()) };
}

function compiles(engine, tpl, opts) {
    try { return (opts ? engine.compile(tpl, opts) : engine.compile(tpl))({ v: '<b>' }); } catch (e) { return 'THREW: ' + e.message; }
}

var getDefaultSrc = extractFunction(SRC, 'getDefaultSwigEngine');
var bridgeSrc     = extractFunction(SRC, 'bridgeRegistrationsToModule');
var exposeSrc     = extractFunction(SRC, 'exposeOptionsOnEngine');

describe('01 - source pins', function () {
    it('defines exposeOptionsOnEngine(engine, opts)', function () {
        assert.match(SRC, /\nfunction exposeOptionsOnEngine\(engine, opts\) \{/);
    });
    it('snapshots the options ONCE at mint and hands back a fresh clone per call', function () {
        assert.match(SRC, /function exposeOptionsOnEngine\(engine, opts\) \{\s*\n\s*var snapshot = JSON\.clone\(opts\);/);
        assert.match(SRC, /engine\.getOptions = function \(\) \{\s*\n\s*return JSON\.clone\(snapshot\);/);
    });
    it('getDefaultSwigEngine exposes the accessor on the line after the #B535 bridge, in the mint branch', function () {
        assert.match(SRC, /bridgeRegistrationsToModule\(process\.gina\._swigDefaultEngines\[templateRoot\], swigMod\);\s*\n[^\n]*\n\s*exposeOptionsOnEngine\(process\.gina\._swigDefaultEngines\[templateRoot\], opts\);/);
    });
    it('the #B514 mint pin and the #B535 bridge pin are untouched', function () {
        assert.match(SRC, /process\.gina\._swigDefaultEngines\[templateRoot\]\s*=\s*new\s+swigMod\.Swig\(opts\);\s*\n[^\n]*\n\s*bridgeRegistrationsToModule\(process\.gina\._swigDefaultEngines\[templateRoot\], swigMod\);/);
    });
    it('the module-side per-request accessor the server reads is still assigned by the controller (exactly once)', function () {
        assert.equal(SRC.split('swig.getOptions = function()').length - 1, 1);
    });
});

describe('02 - the harness reproduces the known pre-fix behaviour before any reading is trusted', function () {
    it('a frozen pre-fix getDefaultSwigEngine mints an instance with NO getOptions accessor', function () {
        var mod = moduleStandIn();
        var pre = load([bridgeSrc, PRE_FIX_GET_DEFAULT_SWIG_ENGINE]);
        var engine = pre.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(false));
        assert.equal(typeof engine.compile, 'function', 'positive control: a real engine was minted');
        assert.equal(typeof engine.getOptions, 'undefined', 'the regression: self.engine.getOptions is not a function');
    });
});

describe('03 - the shipped functions give the per-bundle engine its own getOptions()', function () {
    it('extracts all three shipped functions', function () {
        assert.ok(getDefaultSrc, 'getDefaultSwigEngine extracted');
        assert.ok(bridgeSrc, 'bridgeRegistrationsToModule extracted');
        assert.ok(exposeSrc, 'exposeOptionsOnEngine extracted');
    });

    it('a minted instance carries getOptions(), returning the options it was built with', function () {
        var mod = moduleStandIn(), opts = bundleOpts(true);
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', opts);
        assert.equal(typeof engine.getOptions, 'function');
        var got = engine.getOptions();
        assert.equal(got.autoescape, true);
        assert.equal(got.cache, false);
        assert.deepEqual(Object.keys(got).sort(), ['autoescape', 'cache', 'loader']);
    });

    it('the loader in the copy is a WORKING loader — resolve and load are functions, and swig-core accepts it per call', function () {
        var mod = moduleStandIn(), opts = bundleOpts(false);
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', opts);
        var got = engine.getOptions();
        assert.equal(typeof got.loader.resolve, 'function');
        assert.equal(typeof got.loader.load, 'function');
        assert.notEqual(got.loader, opts.loader, 'a copy, not the same object');
        // a gutted loader would be REFUSED here — this is the arm that distinguishes a real copy from a stripped one
        assert.doesNotThrow(function () { engine.compile('{{ v }}', got); });
        assert.throws(function () { engine.compile('{{ v }}', { loader: {} }); }, /Invalid loader option/, 'control: swig-core does validate a per-call loader');
    });

    it('every call returns a FRESH object — mutating one result reaches neither the next result nor the engine', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(true));
        var a = engine.getOptions(), b = engine.getOptions();
        assert.notEqual(a, b);
        a.autoescape = 'corrupted';
        a.loader.load = 'corrupted';
        assert.equal(b.autoescape, true);
        assert.equal(engine.getOptions().autoescape, true);
        assert.equal(typeof engine.getOptions().loader.load, 'function');
        assert.notEqual(engine.options, a, 'the engine\'s own options are never handed out');
        assert.equal(engine.options.autoescape, true, 'and were not corrupted');
    });

    it('the snapshot is taken at MINT — a later mutation of the options object does not change what getOptions() reports', function () {
        var mod = moduleStandIn(), opts = bundleOpts(false);
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', opts);
        opts.autoescape = true;
        opts.loader = null;
        var got = engine.getOptions();
        assert.equal(got.autoescape, false);
        assert.equal(typeof got.loader.load, 'function');
    });

    it('compile(tpl, engine.getOptions()) is EQUIVALENT to compile(tpl) — the documented round-trip is a no-op, not a degradation', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(true));
        assert.equal(compiles(engine, '{{ v }}', engine.getOptions()), compiles(engine, '{{ v }}'));
        assert.equal(compiles(engine, '{{ v }}'), '&lt;b&gt;', 'positive control: autoescape is on');
        assert.notEqual(compiles(engine, '{{ v }}', { autoescape: false }), compiles(engine, '{{ v }}'), 'control: a differing option DOES change the output');
    });

    it('the accessor lives on the instance only — nothing is written onto the module', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        shipped.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(false));
        assert.equal(typeof mod.getOptions, 'undefined');
    });

    it('minting the same template root twice returns the same instance with ONE accessor', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var a = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(false));
        var b = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', bundleOpts(true));   // a second caller's opts are ignored: the instance is cached
        assert.equal(a, b);
        assert.equal(a.getOptions, b.getOptions);
        assert.equal(b.getOptions().autoescape, false, 'reports what the instance was BUILT with, not the later caller\'s options');
    });

    it('the owner-guard rebuild on a module swap mints a FRESH instance carrying its own accessor', function () {
        var mod1 = moduleStandIn(), mod2 = moduleStandIn();
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var e1 = shipped.api.getDefaultSwigEngine(mod1, '/tpl/a', bundleOpts(false));
        var e2 = shipped.api.getDefaultSwigEngine(mod2, '/tpl/a', bundleOpts(true));
        assert.notEqual(e1, e2);
        assert.equal(typeof e2.getOptions, 'function');
        assert.equal(e2.getOptions().autoescape, true);
        assert.equal(e1.getOptions().autoescape, false, 'the old instance keeps its own snapshot');
    });

    it('on the REAL module: the minted engine exposes getOptions() and the documented call shape works end to end', function () {
        var shipped = load([bridgeSrc, exposeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(swig, '/tpl/real-b538', bundleOpts(false));
        assert.equal(typeof engine.getOptions, 'function');
        var swigOpt = engine.getOptions();
        assert.equal(engine.compile('{{ v }}', swigOpt)({ v: 'x' }), 'x');
    });
});
