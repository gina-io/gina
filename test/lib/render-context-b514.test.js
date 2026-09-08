/**
 * #B514 — render-context isolation on the DEFAULT render path (real bytes).
 *
 * WHAT THIS FILE IS. It drives the REAL `lib/swig-filters` factory — not a
 * replica — to pin the mechanism behind #B514:
 *
 *   `getInstance()` stamps a PROCESS-WIDE singleton on every factory call
 *   (`self.options = SwigFilters.instance._options = conf`,
 *   lib/swig-filters/src/main.js:108), and the context-bearing filters resolve
 *   through `getRenderCtx()` (:128-133) =
 *   `_renderALS.getStore() || SwigFilters.instance._options || self.options`.
 *
 * So whenever a render AWAITS between its factory call and its template
 * invocation, a concurrent render's stamp lands in that window and the resumed
 * render's `t` / `tIcu` / `getUrl` / `getWebroot` read the OTHER request's
 * context. Entering `process.gina._renderALS` makes the store win instead.
 *
 * HONEST SCOPE — read before trusting this file:
 *
 *   (a) These arms prove the MECHANISM on real module bytes. They are NOT
 *       red-first against the fix: `lib/swig-filters` is unchanged by #B514, so
 *       the singleton still bleeds here (that is the point of the subtract arm)
 *       and the ALS still isolates. What the fix changed is that the two DEFAULT
 *       delegates now ENTER that store; those are pinned in
 *       render-engine-dispatch.test.js §03k (e-bis), which IS red-first.
 *   (b) The END-TO-END evidence is a live prod boot, not this file. Measured
 *       2026-09-08 on a built `--env=prod` release (NODE_ENV_IS_DEV=false, so
 *       lib/index.js's `_require` does not cache-bust the module): 50 of 50
 *       concurrent request pairs served one response carrying the other
 *       request's culture; 0 of 100 after the fix; 0 of 3 across a reused
 *       keep-alive connection (2 confirmed reuse events).
 *   (c) The factory needs two gina globals that only `gna.js` sets at real
 *       bundle boot (`GINA_FRAMEWORK_DIR`, `_`). They are shimmed minimally
 *       here — `_` is used by the factory solely to build the `lib/i18n`
 *       require path — and restored afterwards. This is why
 *       test/lib/i18n-filters.test.js pins the `t` wiring by source inspection
 *       instead; that boundary still stands for everything it covers.
 */

'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

var AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;

var SwigFilters = null;
var i18n        = null;
var catalogDir  = null;
var priorGlobals = {};
var priorALS     = null;
var BUNDLE = 'b514bundle';

function ctxFor(culture) {
    return {
        options     : { conf: { bundle: BUNDLE } },
        isProxyHost : false,
        throwError  : function () {},
        req         : { culture: culture },
        res         : {}
    };
}

describe('#B514 - render-context isolation on the default path (real lib/swig-filters)', function () {

    before(function () {
        priorGlobals.FWDIR = global.GINA_FRAMEWORK_DIR;
        priorGlobals.under = global._;
        global.GINA_FRAMEWORK_DIR = FW;
        // Faithful for the single use the factory makes of it: building the
        // `lib/i18n` require path. Not a general PathObject.
        if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }

        SwigFilters = require(path.join(FW, 'lib/swig-filters'));
        i18n        = require(path.join(FW, 'lib/i18n'));

        catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b514-catalogs-'));
        fs.writeFileSync(path.join(catalogDir, 'en.json'), JSON.stringify({ common: { welcome: 'Welcome!' } }));
        fs.writeFileSync(path.join(catalogDir, 'fr.json'), JSON.stringify({ common: { welcome: 'Bienvenue !' } }));

        process.gina = process.gina || {};
        priorALS = process.gina._renderALS;
    });

    after(function () {
        if (typeof priorGlobals.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; }
        else { global.GINA_FRAMEWORK_DIR = priorGlobals.FWDIR; }
        if (typeof priorGlobals.under === 'undefined') { delete global._; }
        else { global._ = priorGlobals.under; }
        if (typeof priorALS === 'undefined') { delete process.gina._renderALS; }
        else { process.gina._renderALS = priorALS; }
        if (catalogDir) { try { fs.rmSync(catalogDir, { recursive: true, force: true }); } catch (e) {} }
    });

    // --- instrument validation ------------------------------------------------

    it('instrument: the two catalogs load and t() discriminates cultures', function () {
        var loaded = i18n.loadCatalogs(BUNDLE, catalogDir);
        assert.deepEqual(loaded.slice().sort(), ['en', 'fr'], 'both cultures loaded');
        // A known-POSITIVE and a known-NEGATIVE for the reading instrument: if
        // t() answered the same for both cultures, every arm below would be
        // vacuous.
        assert.equal(i18n.t('common.welcome', null, 'fr', { bundleName: BUNDLE }), 'Bienvenue !');
        assert.equal(i18n.t('common.welcome', null, 'en', { bundleName: BUNDLE }), 'Welcome!');
        assert.notEqual(
            i18n.t('common.welcome', null, 'fr', { bundleName: BUNDLE }),
            i18n.t('common.welcome', null, 'en', { bundleName: BUNDLE }),
            'the two cultures must render differently or the arms cannot fail'
        );
    });

    it('instrument: a filter handle reads its OWN context when nothing else has stamped since', function () {
        i18n.loadCatalogs(BUNDLE, catalogDir);
        delete process.gina._renderALS;
        var fFR = SwigFilters(ctxFor('fr'));
        assert.equal(fFR.t('common.welcome'), 'Bienvenue !', 'baseline: fr handle reads fr');
    });

    // --- the defect, on real bytes -------------------------------------------

    it('SUBTRACT (no ALS): a second factory call across an await steals the first handle\'s context', async function () {
        i18n.loadCatalogs(BUNDLE, catalogDir);
        delete process.gina._renderALS;              // the pre-#B514 default path

        var fFR = SwigFilters(ctxFor('fr'));          // "request A" stamps the singleton
        assert.equal(fFR.t('common.welcome'), 'Bienvenue !', 'A reads its own context before the interleave');

        await new Promise(function (r) { setTimeout(r, 1); });   // A suspends (the layout read)

        SwigFilters(ctxFor('en'));                    // "request B" stamps it too

        assert.equal(
            fFR.t('common.welcome'), 'Welcome!',
            'the singleton bleeds: A resumes and reads B context (this IS #B514)'
        );
    });

    // --- the fix mechanism, on real bytes ------------------------------------

    it('WITH the ALS store entered, each render reads its OWN context despite the shared singleton', async function () {
        i18n.loadCatalogs(BUNDLE, catalogDir);
        var als = new AsyncLocalStorage();
        process.gina._renderALS = als;

        var ctxA = ctxFor('fr');
        var ctxB = ctxFor('en');

        var runOne = function (ctx, expected) {
            return als.run(ctx, async function () {
                var handle = SwigFilters(ctx);                    // stamps the singleton
                await new Promise(function (r) { setTimeout(r, 1); });  // interleave window
                SwigFilters(ctx === ctxA ? ctxB : ctxA);          // the other render stamps it
                return handle.t('common.welcome');
            });
        };

        var out = await Promise.all([ runOne(ctxA), runOne(ctxB) ]);
        assert.equal(out[0], 'Bienvenue !', 'fr render reads fr from the ALS store, not the raced singleton');
        assert.equal(out[1], 'Welcome!',    'en render reads en from the ALS store, not the raced singleton');
    });

    it('enterWith (the shape the default delegates use) isolates two interleaved renders', async function () {
        i18n.loadCatalogs(BUNDLE, catalogDir);
        var als = new AsyncLocalStorage();
        process.gina._renderALS = als;

        // Each "render" runs in its own async context, enters its store the way
        // controller.render-swig.js does right after its SwigFilters() call, then
        // awaits while the other render stamps the singleton.
        var render = function (culture, other) {
            return (async function () {
                var ctx    = ctxFor(culture);
                var handle = SwigFilters(ctx);
                als.enterWith(ctx);
                await new Promise(function (r) { setTimeout(r, 1); });
                SwigFilters(ctxFor(other));
                return handle.t('common.welcome');
            })();
        };

        var out = await Promise.all([ render('fr', 'en'), render('en', 'fr') ]);
        assert.equal(out[0], 'Bienvenue !', 'fr render isolated under enterWith');
        assert.equal(out[1], 'Welcome!',    'en render isolated under enterWith');
    });

});
