'use strict';
/**
 * #B808 — a bundle configured with a custom async swig template loader
 * (`settings.template.swig.loader`) answered 500 on every page render from
 * 0.6.30 to 0.7.3.
 *
 * Since #B514 (0.6.30) controller.js hands every render delegate the bundle's
 * own engine INSTANCE as `deps.swig`. The async delegate builds a separate
 * engine of its own, `new swigMod.Swig({ loader })`, and an instance has no
 * `.Swig`: every render threw `TypeError: swigMod.Swig is not a constructor`,
 * which the delegate answered through throwError. The fix hands the module as
 * `deps.swigModule`; the sync delegate keeps rendering through the instance.
 *
 * §01 — source pins: controller.js hands the module; the delegate builds from it.
 * §02 — the premise, on the real swig: an engine instance has no `.Swig`, the
 *       module has one (green before and after the fix: it says why).
 * §03 — behavioural, on the REAL delegate module: the deps controller.js builds,
 *       with the engine instance minted by the REAL getDefaultSwigEngine lifted
 *       from controller.js, render the page and its `{% extends %}` parent
 *       through the async loader; the shape every release from 0.6.30 to 0.7.3
 *       handed fails with the TypeError; a module handed as `deps.swig` (the
 *       shape before 0.6.30) still renders.
 *
 * Red first: against the pre-fix tree, §01's module pins and §03's fix arm fail.
 */

var assert     = require('node:assert');
var fs         = require('node:fs');
var path       = require('node:path');
var describe   = require('node:test').describe;
var it         = require('node:test').it;
var beforeEach = require('node:test').beforeEach;
var afterEach  = require('node:test').afterEach;

var FW             = require('../fw');
var CONTROLLER_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var DELEGATE_PATH  = path.join(FW, 'core/controller/controller.render-swig-async.js');
var DELEGATE_SRC   = fs.readFileSync(DELEGATE_PATH, 'utf8');

var swig = null;
try { swig = require('@rhinostone/swig'); } catch (e) { swig = null; }


describe('01 - #B808 source pins', function () {

    it('controller.js hands the render delegates the swig MODULE as deps.swigModule', function () {
        assert.match(CONTROLLER_SRC, /swigModule\s*:\s*swig\s*,/);
    });

    it('controller.js still hands the per-bundle engine as deps.swig (the sync delegate renders through it, #B514)', function () {
        assert.match(CONTROLLER_SRC, /swig\s*:\s*\(local\._swigEngine\s*\|\|\s*swig\)/);
    });

    it('the async delegate builds its engine from deps.swigModule, falling back to deps.swig', function () {
        // a comment line starts with `//`, so it can never match `^\s*var`
        var lines = DELEGATE_SRC.split('\n').filter(function (l) { return /^\s*var\s+swigMod\s*=/.test(l); });
        assert.equal(lines.length, 1, 'exactly one live `var swigMod =` line');
        assert.match(lines[0], /^\s*var\s+swigMod\s*=\s*deps\.swigModule\s*\|\|\s*deps\.swig\s*;/);
    });
});


describe('02 - the premise, on the real swig (green before and after the fix)', function () {

    it('the swig module exposes the Swig constructor; an engine instance does not', function (t) {
        if (!swig) { t.skip('@rhinostone/swig not installed'); return; }
        assert.equal(typeof swig.Swig, 'function');
        var inst = new swig.Swig({ cache: false });
        assert.equal(typeof inst.Swig, 'undefined');
        assert.throws(
            function () { return new inst.Swig({}); },
            function (e) { return e instanceof TypeError && /not a constructor/.test(e.message); }
        );
    });
});


// Runtime tests — framework-globals bootstrap (the controller-custom-error-preload.test.js §03 recipe).
describe('03 - #B808 behavioural: the real async delegate', function () {

    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    require(path.join(FW, '..', '..', 'utils', 'prototypes'));
    setPath('gina', { core: path.join(FW, 'core') });

    var renderSwigAsync = require(DELEGATE_PATH);
    var tlBuild         = require(path.join(FW, 'lib/template-loaders/src/main.js')).build;

    // A registry key only: the async loader serves the templates from memory, and
    // the per-bundle engine's fs loader is never asked for a file here.
    var ROOT = path.join(require('node:os').tmpdir(), 'b808-unused-root', 'templates', 'html');
    var TEMPLATES = {
        'layout.html'  : '<!doctype html><html><head><title>b808</title></head><body>{% block body %}{% endblock %}</body></html>',
        'b808page.html': '{% extends "layout.html" %}{% block body %}<p id="marker">B808-ASYNC-OK</p><p id="text">{{ text }}</p>{% endblock %}'
    };
    var KEYS = ['_swigLoaders', '_swigEngines', '_swigEnginesOwner', '_swigDefaultEngines', '_swigDefaultEnginesOwner', '_renderALS'];
    var saved = null;

    /**
     * The per-bundle engine controller.js mints for a template root: the REAL
     * getDefaultSwigEngine with the two helpers it calls, lifted from
     * controller.js. They close over nothing but their parameters and the
     * `process` / `JSON` globals, so compiling them outside the module is sound.
     *
     * @returns {function} getDefaultSwigEngine(swigMod, templateRoot, opts)
     */
    function liftGetDefaultSwigEngine() {
        var start = CONTROLLER_SRC.indexOf('function bridgeRegistrationsToModule(engine, swigMod) {');
        var gde   = CONTROLLER_SRC.indexOf('function getDefaultSwigEngine(swigMod, templateRoot, opts) {');
        assert.ok(start > -1, 'bridgeRegistrationsToModule found');
        assert.ok(gde > start, 'getDefaultSwigEngine found after it');
        var end = CONTROLLER_SRC.indexOf('\n}\n', gde);
        assert.ok(end > gde, 'getDefaultSwigEngine end found');
        return new Function(CONTROLLER_SRC.slice(start, end + 2) + '\nreturn getDefaultSwigEngine;')();
    }
    var getDefaultSwigEngine = liftGetDefaultSwigEngine();

    /**
     * Deps as controller.js's render() hands them to a delegate, with a captured
     * response and throwError.
     *
     * @param {*} depsSwig         - What `deps.swig` carries
     * @param {*} [depsSwigModule] - What `deps.swigModule` carries; omitted ⇒ key absent
     * @returns {{deps: object, sent: object, thrown: Array}}
     */
    function mkDeps(depsSwig, depsSwigModule) {
        var sent = { status: null, body: null, headers: {} };
        var thrown = [];
        var res = {
            statusCode : 200,
            headersSent: false,
            getHeader  : function (k) { return sent.headers[String(k).toLowerCase()]; },
            setHeader  : function (k, v) { sent.headers[String(k).toLowerCase()] = v; },
            getHeaders : function () { return sent.headers; },
            writeHead  : function (code) { sent.status = code; },
            end        : function (body) { sent.body = (typeof body === 'undefined') ? '' : String(body); res.headersSent = true; }
        };
        var req = { method: 'GET', url: '/b808', headers: { host: '127.0.0.1:3100' } };
        var localOptions = {
            bundle  : 'b808',
            template: {},
            conf    : {
                bundle  : 'b808',
                env     : 'dev',
                hostname: 'http://127.0.0.1:3100',
                host    : '127.0.0.1',
                server  : { scheme: 'http', port: 3100 },
                content : { templates: { _common: { html: ROOT } } }
            }
        };
        var deps = {
            self        : { throwError: function (err) { thrown.push(err); } },
            local       : { req: req, res: res, next: function () {}, options: localOptions },
            getData     : function () { return { page: { view: { file: 'b808page', ext: '.html' }, data: {} } }; },
            hasViews    : function () { return true; },
            setResources: function () {},
            SwigFilters : function () { return {}; },
            headersSent : function () { return res.headersSent === true; },
            swig        : depsSwig
        };
        if (typeof depsSwigModule !== 'undefined') {
            deps.swigModule = depsSwigModule;
        }
        return { deps: deps, sent: sent, thrown: thrown };
    }

    /**
     * The engine instance controller.js hands as `deps.swig` for this root.
     *
     * @returns {*} the per-bundle engine (cached per root, as in controller.js)
     */
    function bundleEngine() {
        return getDefaultSwigEngine(swig, ROOT, { autoescape: true, cache: false, loader: swig.loaders.fs(ROOT) });
    }

    beforeEach(function () {
        process.gina = process.gina || {};
        saved = {};
        KEYS.forEach(function (k) { saved[k] = { had: Object.prototype.hasOwnProperty.call(process.gina, k), v: process.gina[k] }; delete process.gina[k]; });
        process.gina._swigLoaders = Object.create(null);
        process.gina._swigLoaders[ROOT] = { loader: tlBuild({ type: 'memory', templates: TEMPLATES }), autoescape: true, cache: false };
    });

    afterEach(function () {
        KEYS.forEach(function (k) { if (saved[k].had) { process.gina[k] = saved[k].v; } else { delete process.gina[k]; } });
    });

    it('the deps controller.js builds (the instance as deps.swig, the module as deps.swigModule) render the page through the async loader', async function (t) {
        if (!swig) { t.skip('@rhinostone/swig not installed'); return; }
        assert.equal(process.gina._swigLoaders[ROOT].loader.async, true, 'fixture: the memory loader is an async loader');
        var instance = bundleEngine();
        assert.equal(typeof instance.Swig, 'undefined', 'fixture: deps.swig is an engine instance, as controller.js hands it');

        var r = mkDeps(instance, swig);
        await renderSwigAsync({ text: 'hello' }, false, null, r.deps);
        assert.deepEqual(r.thrown.map(String), [], 'no throwError');
        assert.equal(r.sent.status, 200);
        assert.match(r.sent.body, /<p id="marker">B808-ASYNC-OK<\/p>/, 'the page template came from the async loader');
        assert.match(r.sent.body, /<title>b808<\/title>/, 'its {% extends %} parent resolved through the loader too');
        assert.match(r.sent.body, /<p id="text">hello<\/p>/, 'the render data reached the template');
        assert.strictEqual(process.gina._swigEnginesOwner, swig, 'the async registry is owned by the swig module');
        assert.ok(process.gina._swigEngines[ROOT].engine instanceof swig.Swig, 'the async engine is a swig instance of its own');
        assert.notStrictEqual(process.gina._swigEngines[ROOT].engine, instance, 'it is not the per-bundle default engine');

        // a second render reuses the same async engine
        var first = process.gina._swigEngines[ROOT].engine;
        var r2 = mkDeps(bundleEngine(), swig);
        await renderSwigAsync({ text: 'again' }, false, null, r2.deps);
        assert.deepEqual(r2.thrown.map(String), []);
        assert.match(r2.sent.body, /<p id="text">again<\/p>/);
        assert.strictEqual(process.gina._swigEngines[ROOT].engine, first, 'the engine is minted once per root');
    });

    it('the shape 0.6.30 to 0.7.3 handed (the instance only) fails the way #B808 was reported: TypeError through throwError, nothing sent', async function (t) {
        if (!swig) { t.skip('@rhinostone/swig not installed'); return; }
        var r = mkDeps(bundleEngine());
        await renderSwigAsync({ text: 'hello' }, false, null, r.deps);
        assert.equal(r.thrown.length, 1, 'answered through throwError');
        assert.ok(r.thrown[0] instanceof TypeError, 'a TypeError');
        // V8: "swigMod.Swig is not a constructor"; JavaScriptCore (Bun): "undefined is not a
        // constructor (evaluating 'new swigMod.Swig({…})')" — both name the constructor call
        assert.match(r.thrown[0].message, /not a constructor/);
        assert.match(r.thrown[0].message, /swigMod\.Swig/);
        assert.equal(r.sent.body, null, 'nothing was sent by the delegate');
    });

    it('a module handed as deps.swig with no deps.swigModule (the shape before 0.6.30) still renders', async function (t) {
        if (!swig) { t.skip('@rhinostone/swig not installed'); return; }
        var r = mkDeps(swig);
        await renderSwigAsync({ text: 'module' }, false, null, r.deps);
        assert.deepEqual(r.thrown.map(String), []);
        assert.equal(r.sent.status, 200);
        assert.match(r.sent.body, /<p id="marker">B808-ASYNC-OK<\/p>/);
        assert.match(r.sent.body, /<p id="text">module<\/p>/);
        assert.strictEqual(process.gina._swigEnginesOwner, swig);
    });
});
