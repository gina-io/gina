'use strict';

/**
 * Playwright RUNTIME e2e for #B1109 — popinLoad copies the options it is given.
 *
 * `gina.popin.load(name, url, options)` runs on the published popin instance, whose
 * `xhrOptions` defaults serve every popin loaded through it. With no options, popinLoad took
 * that defaults object itself; with options, the caller's object; then
 * `$popin.options = merge(options, $popin.options)` (lib/merge mutates and returns its
 * target) adopted it as the popin's options. Two popins loaded that way shared ONE options
 * object: the second took the first's `preOpen` (its loading shell showed) and `loadTimeout`
 * (its load failed at the first popin's limit). The fix copies the defaults, and a caller's
 * object unless it is the popin's own options.
 *
 * Harness: the real built bundle from runtime-server.js, the page `page.route`'d, every
 * content request HELD by its route (never answered), so each popin's state is read while
 * its load is in flight. alpha: `preOpen: true`, `loadTimeout: 1000`, its own class;
 * beta: no options of its own.
 *
 * Red-first: on the pre-#B1109 bundle, 01 and 02 fail (beta reads alpha's options, shows a
 * loading shell and fails at alpha's limit). 03 and 04 pass on both sides: a fresh options
 * object per load (the declarative click's shape) and the popin's own options passed back
 * (the validator redirect's shape) never shared.
 *
 * Run (a dedicated port, so reuseExistingServer can never pick up another tree's server):
 *   GINA_E2E_PORT=3293 npx playwright test test/e2e/popin-shared-options-b1109.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;
const ALPHA_LIMIT = 1000;

// The route-served page has no server-rendered boot call: run the loader's
// onGinaLoaded once the bundle is in (popin-loading-state.spec.js's kicker).
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>shared options</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>shared options</h1>'
    + '<button id="trig-unused" data-gina-dialog="unused" data-gina-dialog-src="/fragUnused" data-gina-dialog-preload="false">unused</button>'
    + '</body></html>';

/**
 * Loads the scene, waits for the popin handler, then constructs alpha and beta and watches
 * their `open` / `close` / `error` events.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function gotoScene(page) {
    await page.route('**/shared-options', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto(BASE + '/shared-options');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null, { timeout: 15000 }
    );
    const reg = await page.evaluate((limit) => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var defs = [
                { name: 'alpha', preOpen: true, loadTimeout: limit, 'class': 'alpha-cls' },
                { name: 'beta' }
            ];
            var chain = Promise.resolve();
            defs.forEach(function (d) {
                chain = chain.then(function () {
                    return new Promise(function (r) { new Popin(d).on('ready', function () { r(); }); });
                });
            });
            chain.then(function () {
                window.__rec = {};
                ['alpha', 'beta'].forEach(function (n) {
                    var p = window.gina.popin.getPopinByName(n);
                    var rec = window.__rec[n] = { open: 0, close: 0, error: 0, errors: [] };
                    ['open', 'close', 'error'].forEach(function (k) {
                        document.addEventListener(k + '.' + p.id, function (e) {
                            rec[k]++;
                            if (k === 'error') {
                                var d;
                                try { d = JSON.parse(JSON.stringify(e.detail)); } catch (x) { d = String(e.detail); }
                                rec.errors.push(d);
                            }
                        }, true);
                    });
                });
                resolve('READY');
            });
        });
    }), ALPHA_LIMIT);
    expect(reg, 'the popins must register').toBe('READY');
}

/**
 * Holds every content request: the route never answers it.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{seen: object}>}
 */
async function holdContent(page) {
    const seen = { alpha: 0, beta: 0 };
    await page.route(/\/frag(Alpha|Beta)$/, (route) => {
        seen[/Alpha$/.test(route.request().url()) ? 'alpha' : 'beta']++;
        // never fulfilled: the load stays in flight
    });
    return { seen };
}

/**
 * Reads both popins: their options, whether they share one object, and each dialog's
 * loading shell.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<object>}
 */
function readBoth(page) {
    return page.evaluate(() => {
        var a = window.gina.popin.getPopinByName('alpha'), b = window.gina.popin.getPopinByName('beta');
        var view = function (p) {
            var el = document.getElementById(p.id);
            return {
                name: p.options.name, preOpen: p.options.preOpen, loadTimeout: p.options.loadTimeout,
                shellOpen: !!(el && el.hasAttribute('open')), skeleton: !!(el && el.querySelector('.gina-popin-skeleton')),
                isLoading: p.isLoading === true, rec: window.__rec[p.name]
            };
        };
        return { shared: a.options === b.options, alpha: view(a), beta: view(b) };
    });
}

/**
 * Collects page errors.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    return errors;
}

/**
 * Expects beta to read and behave as a popin with no options of its own: no shell, no
 * limit (no `error` after alpha's limit has passed), its own name.
 *
 * @param {object} s - readBoth() after alpha's limit has passed
 * @returns {void}
 */
function expectBetaOwn(s) {
    expect(s.shared, 'alpha and beta hold different options objects').toBe(false);
    expect(s.beta.name).toBe('beta');
    expect(s.beta.preOpen, "beta's preOpen is its own (false)").toBe(false);
    expect(s.beta.shellOpen, 'beta shows no loading shell').toBe(false);
    expect(s.beta.rec.error, "beta's load does not fail at alpha's limit").toBe(0);
}

/**
 * Expects alpha to keep its own behaviour: its shell showed and its load failed at its own
 * limit with the 408 payload.
 *
 * @param {object} s - readBoth() after alpha's limit has passed
 * @returns {void}
 */
function expectAlphaOwn(s) {
    expect(s.alpha.rec.error, "alpha's load fails at its own limit").toBe(1);
    expect(s.alpha.rec.errors[0]).toEqual({ status: 408, error: 'Request Timeout' });
}

test.describe('#B1109 — popinLoad copies the options it is given (real bundle)', () => {
    test.setTimeout(30000);

    test('01 two loads without options through gina.popin.load: beta keeps its own options (no shell, no limit)', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        const h = await holdContent(page);
        await page.evaluate(() => {
            window.gina.popin.load('alpha', '/fragAlpha');
            window.gina.popin.load('beta', '/fragBeta');
        });
        await expect.poll(() => h.seen.alpha + h.seen.beta, { timeout: 5000 }).toBe(2);
        await page.waitForTimeout(ALPHA_LIMIT + 600);
        const s = await readBoth(page);
        expectBetaOwn(s);
        expectAlphaOwn(s);
        expect(pageErrors).toEqual([]);
    });

    test("02 one options object passed to both loads: beta keeps its own options, and the caller's object is left as it was", async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        const h = await holdContent(page);
        const keys = await page.evaluate(() => {
            var o = {};
            window.gina.popin.load('alpha', '/fragAlpha', o);
            window.gina.popin.load('beta', '/fragBeta', o);
            window.__callerObject = o;
            return Object.keys(o);
        });
        await expect.poll(() => h.seen.alpha + h.seen.beta, { timeout: 5000 }).toBe(2);
        await page.waitForTimeout(ALPHA_LIMIT + 600);
        const s = await readBoth(page);
        expect(keys, "the caller's object gained no key").toEqual([]);
        expectBetaOwn(s);
        expectAlphaOwn(s);
        expect(pageErrors).toEqual([]);
    });

    test('03 CONTROL — a fresh options object per load (the declarative click passes one) never shared (true before and after #B1109)', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        const h = await holdContent(page);
        await page.evaluate(() => {
            window.gina.popin.load('alpha', '/fragAlpha', {});
            window.gina.popin.load('beta', '/fragBeta', {});
        });
        await expect.poll(() => h.seen.alpha + h.seen.beta, { timeout: 5000 }).toBe(2);
        await page.waitForTimeout(ALPHA_LIMIT + 600);
        const s = await readBoth(page);
        expectBetaOwn(s);
        expectAlphaOwn(s);
        expect(pageErrors).toEqual([]);
    });

    test("04 CONTROL — each popin's own options passed back (the validator redirect's shape) keep their identity (true before and after #B1109)", async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        const h = await holdContent(page);
        const kept = await page.evaluate(() => {
            var a = window.gina.popin.getPopinByName('alpha'), b = window.gina.popin.getPopinByName('beta');
            var oa = a.options, ob = b.options;
            a.load(a.name, '/fragAlpha', a.options);
            b.load(b.name, '/fragBeta', b.options);
            return { alpha: a.options === oa, beta: b.options === ob };
        });
        await expect.poll(() => h.seen.alpha + h.seen.beta, { timeout: 5000 }).toBe(2);
        await page.waitForTimeout(ALPHA_LIMIT + 600);
        const s = await readBoth(page);
        expect(kept, 'each popin keeps its own options object').toEqual({ alpha: true, beta: true });
        expectBetaOwn(s);
        expectAlphaOwn(s);
        expect(pageErrors).toEqual([]);
    });
});
