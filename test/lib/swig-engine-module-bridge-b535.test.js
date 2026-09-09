/**
 * core/controller/controller.js — the per-bundle swig engine bridges its registrations to the module (#B535)
 *
 * #B514 pointed `self.engine` at a per-template-root `new swig.Swig()` instance. swig-core's
 * `install()` gives every instance FRESH filter/tag/extension maps — copied from the frontend's
 * built-in library, not from the module's runtime registrations — and keeps them closure-private
 * afterwards, so a bundle's `controllers/setup.js` registrations stopped reaching every compile
 * made through the MODULE (an application's own `require('@rhinostone/swig').compile()`, gina's
 * `core/server.js` asset-URL compile). On 0.6.29 they all landed on the module because
 * `self.engine` WAS the module. `bridgeRegistrationsToModule` restores that reach at the one
 * seam where it is lost: each setter registers on the instance, then on the module.
 *
 * The behaviour arms drive the REAL fork through the functions extracted from controller.js
 * (their only free identifier is `process`, injected as a fake so the registry is isolated).
 * A frozen verbatim copy of the PRE-fix `getDefaultSwigEngine` is driven first through the
 * same harness and must reproduce the known regression, or no later reading is trusted.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

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
    var body = fnSources.join('\n') + '\nreturn { getDefaultSwigEngine: typeof getDefaultSwigEngine === "function" ? getDefaultSwigEngine : null, bridgeRegistrationsToModule: typeof bridgeRegistrationsToModule === "function" ? bridgeRegistrationsToModule : null };';
    return { api: new Function('process', body)(fakeProcess), process: fakeProcess };
}

// The pre-fix function, verbatim from 0e443f83b — the known-behaviour control.
var PRE_FIX_GET_DEFAULT_SWIG_ENGINE = [
    'function getDefaultSwigEngine(swigMod, templateRoot, opts) {',
    '    if (!process.gina._swigDefaultEngines) {',
    '        process.gina._swigDefaultEngines = Object.create(null);',
    '    }',
    '    if (process.gina._swigDefaultEnginesOwner !== swigMod) {',
    '        process.gina._swigDefaultEngines      = Object.create(null);',
    '        process.gina._swigDefaultEnginesOwner = swigMod;',
    '    }',
    '    if (!process.gina._swigDefaultEngines[templateRoot]) {',
    '        process.gina._swigDefaultEngines[templateRoot] = new swigMod.Swig(opts);',
    '    }',
    '    return process.gina._swigDefaultEngines[templateRoot];',
    '}'
].join('\n');

/** A private stand-in for the swig module: a fresh instance that ALSO exposes the `.Swig` constructor, as the module does. */
function moduleStandIn() { var m = new swig.Swig({}); m.Swig = swig.Swig; return m; }

function compiles(engine, tpl) {
    try { return engine.compile(tpl)({}); } catch (e) { return 'THREW: ' + e.message; }
}

var getDefaultSrc = extractFunction(SRC, 'getDefaultSwigEngine');
var bridgeSrc     = extractFunction(SRC, 'bridgeRegistrationsToModule');

describe('01 - source pins', function () {
    it('defines bridgeRegistrationsToModule(engine, swigMod)', function () {
        assert.match(SRC, /\nfunction bridgeRegistrationsToModule\(engine, swigMod\) \{/);
    });
    it('bridges the three registration setters, instance first, then the module', function () {
        assert.match(SRC, /engine\.setFilter = function \(name, method\) \{\s*\n\s*var result = _setFilter\.apply\(engine, arguments\);\s*\n\s*swigMod\.setFilter\(name, method\);/);
        assert.match(SRC, /engine\.setTag = function \(name, parse, compile, ends, blockLevel\) \{\s*\n\s*var result = _setTag\.apply\(engine, arguments\);\s*\n\s*swigMod\.setTag\(name, parse, compile, ends, blockLevel\);/);
        assert.match(SRC, /engine\.setExtension = function \(name, object\) \{\s*\n\s*var result = _setExtension\.apply\(engine, arguments\);\s*\n\s*swigMod\.setExtension\(name, object\);/);
    });
    it('getDefaultSwigEngine bridges the instance on the line after minting it (the #B514 mint pin is untouched)', function () {
        assert.match(SRC, /process\.gina\._swigDefaultEngines\[templateRoot\]\s*=\s*new\s+swigMod\.Swig\(opts\);\s*\n[^\n]*\n\s*bridgeRegistrationsToModule\(process\.gina\._swigDefaultEngines\[templateRoot\], swigMod\);/);
    });
    it('is idempotent per (instance, module) via a marker', function () {
        assert.match(SRC, /if \(engine\._ginaModuleBridge === swigMod\) \{\s*\n\s*return engine;/);
        assert.match(SRC, /engine\._ginaModuleBridge = swigMod;/);
    });
});

describe('02 - the harness reproduces the known pre-fix behaviour before any reading is trusted', function () {
    it('a frozen pre-fix getDefaultSwigEngine mints an instance whose filters never reach the module', function () {
        var mod = moduleStandIn();
        var pre = load([PRE_FIX_GET_DEFAULT_SWIG_ENGINE]);
        var engine = pre.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        engine.setFilter('b535pre', function () { return 'X'; });
        assert.equal(compiles(engine, '{{ ""|b535pre }}'), 'X', 'positive control: the instance resolves its own filter');
        assert.match(compiles(mod, '{{ ""|b535pre }}'), /THREW: Invalid filter "b535pre"/, 'the regression: the module never sees it');
    });
});

describe('03 - the shipped functions bridge registrations to the module', function () {
    it('extracts both shipped functions', function () {
        assert.ok(getDefaultSrc, 'getDefaultSwigEngine extracted');
        assert.ok(bridgeSrc, 'bridgeRegistrationsToModule extracted');
    });

    it('a filter registered on the per-bundle instance is compiled by the module (and still by the instance)', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        engine.setFilter('b535f', function () { return 'F'; });
        assert.equal(compiles(mod, '{{ ""|b535f }}'), 'F');
        assert.equal(compiles(engine, '{{ ""|b535f }}'), 'F');
        assert.notEqual(engine, mod, 'the instance is still not the module');
    });

    it('a tag and an extension registered on the instance reach the module too', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        engine.setTag('b535tag', function () { return true; }, function () { return '_output += "TAGOUT";'; }, false, false);
        engine.setExtension('b535ext', { v: 41 });
        assert.equal(compiles(mod, '{% b535tag %}'), 'TAGOUT');
        assert.equal(compiles(mod, '{{ _ext.b535ext.v }}'), '41');
    });

    it('an invalid registration throws from the instance and leaves the module untouched', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        assert.throws(function () { engine.setFilter('b535bad', 'not a function'); }, /not a valid function/);
        assert.match(compiles(mod, '{{ ""|b535bad }}'), /Invalid filter "b535bad"/);
    });

    it('minting the same template root twice returns the same bridged instance, and one registration writes the module once', function () {
        var mod = moduleStandIn(), writes = 0, orig = mod.setFilter;
        mod.setFilter = function () { writes++; return orig.apply(mod, arguments); };
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var a = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        var b = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        assert.equal(a, b);
        shipped.api.bridgeRegistrationsToModule(a, mod);           // a second bridge must be a no-op
        a.setFilter('b535once', function () { return '1'; });
        assert.equal(writes, 1);
    });

    it('the owner-guard rebuild on a module swap mints a FRESH instance and bridges it to the new module', function () {
        var mod1 = moduleStandIn(), mod2 = moduleStandIn();
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var e1 = shipped.api.getDefaultSwigEngine(mod1, '/tpl/a', {});
        var e2 = shipped.api.getDefaultSwigEngine(mod2, '/tpl/a', {});
        assert.notEqual(e1, e2);
        e2.setFilter('b535swap', function () { return 'S'; });
        assert.equal(compiles(mod2, '{{ ""|b535swap }}'), 'S');
        assert.match(compiles(mod1, '{{ ""|b535swap }}'), /Invalid filter/, 'the old module is not written');
    });

    it('the instance keeps its OWN loader — #B514 include/extends isolation is untouched', function () {
        var mod = moduleStandIn();
        var loader = swig.loaders.fs('/tpl/a');
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', { loader: loader });
        engine.setFilter('b535l', function () { return 'L'; });
        assert.equal(engine.options.loader, loader);
        assert.notEqual(mod.options.loader, loader);
    });

    it('the reverse direction is NOT bridged: a later module registration stays invisible to the instance (documented)', function () {
        var mod = moduleStandIn();
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(mod, '/tpl/a', {});
        mod.setFilter('b535rev', function () { return 'R'; });
        assert.equal(compiles(mod, '{{ ""|b535rev }}'), 'R', 'control: the module resolves its own');
        assert.match(compiles(engine, '{{ ""|b535rev }}'), /Invalid filter "b535rev"/);
    });

    it('on the REAL module: a bundle-style registration on the bridged instance is compiled through require("@rhinostone/swig")', function () {
        var shipped = load([bridgeSrc, getDefaultSrc]);
        var engine = shipped.api.getDefaultSwigEngine(swig, '/tpl/real-b535', {});
        engine.setFilter('b535_real', function () { return 'REAL'; });
        assert.equal(compiles(swig, '{{ ""|b535_real }}'), 'REAL');
    });
});
