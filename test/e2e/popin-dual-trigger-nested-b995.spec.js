'use strict';

/**
 * Playwright RUNTIME e2e for #B995 — a click on markup added inside a dual-role element (a legacy trigger
 * that is also a `.gina-popin-close`) after `bindOpen` stamped it.
 *
 * The element is dual-role when `popinBind` binds it as a close button BEFORE `bindOpen` rewrites its id to
 * the trigger's `popin.click.*` id: here an in-page dialog P1 is opened first (its close buttons are bound),
 * then the AJAX popin P3 is registered by its first open, and P3's `bindOpen` stamps the legacy trigger for
 * P3 that sits inside P1. `register()`'s close branch then dispatches the trigger instead of closing P1. It
 * read the event name from `event.target`, the node clicked: markup present when `bindOpen` ran has its own
 * `proxyClick` listener and never gets there, but a node added afterwards did, and its id matched nothing.
 *
 * Arms (each counts the trigger's own `popin.click.*` dispatches and P3's GETs):
 *   01 a click on a node added inside the trigger after bindOpen dispatches it once and opens P3
 *   02 CONTROL — a click on the trigger itself dispatches it once
 *   03 CONTROL — a click on markup present when bindOpen ran dispatches it once (proxyClick)
 *
 * Subtract lever: B995_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle URL
 * (page.route, zero disk mutation); `routeHits` counts the copies served, and `openScene` asserts at least one
 * whenever the lever is set.
 *
 * Run:
 *   npx playwright test test/e2e/popin-dual-trigger-nested-b995.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>dual-role trigger</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>dual-role trigger</h1>'
    + '<button id="trig-p1" type="button" data-gina-dialog="P1">Open P1</button> '
    + '<button id="trig-p3" type="button" data-gina-dialog="P3" data-gina-dialog-src="/b995/p3" data-gina-dialog-preload="false">Open P3</button>'
    + '<dialog id="P1"><p>P1 body</p>'
    + '<button type="button" class="gina-popin-close" data-gina-popin-name="P3" data-gina-popin-url="/b995/p3"'
    + ' data-gina-dialog-preload="false" data-probe="dual" style="padding:12px"><span class="nest">Open P3 from P1</span></button>'
    + '</dialog>'
    + '</body></html>';

const P3_FRAG = '<div id="p3body"><p>P3</p><button class="gina-popin-close" type="button">Close</button></div>';

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B995_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B995_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/**
 * Load the page, open P1 (its close buttons bound), then register P3 by its first open and close it (P3's
 * bindOpen stamps the legacy trigger inside P1). Arms a dispatch counter on the trigger's own event name.
 * Returns the counters and the trigger's id.
 */
async function openScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { p3: 0 };
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
    await page.route('**/b995', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b995/p3', (r) => { reqs.p3++; return r.fulfill(html(P3_FRAG)); });
    await page.goto(BASE + '/b995');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    if (process.env.B995_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B995_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('trig-p1').click());
    await page.waitForSelector('dialog#P1[open]', { timeout: 8000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('trig-p3').click());
    await page.waitForSelector('dialog[open] #p3body', { timeout: 8000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.gina.popin.close('P3'));
    await page.waitForTimeout(300);
    const id = await page.evaluate(() => {
        var t = document.querySelector('[data-probe="dual"]');
        window.__b995disp = 0;
        t.addEventListener(t.id, function () { window.__b995disp++; });
        return t.id;
    });
    // scene control: the element is a close button of P1 AND carries P3's trigger id
    expect(id, 'P3\'s bindOpen stamped the trigger inside P1').toMatch(/^popin\.click\.gina-popin-.+-P3$/);
    return { routeHits, reqs, p3Before: reqs.p3 };
}

function readState(page) {
    return page.evaluate(() => {
        var p3 = window.gina.popin.getPopinByName('P3');
        return {
            dispatches: window.__b995disp,
            p3Open: !!(p3 && p3.isOpen === true),
            p1Open: document.getElementById('P1').open,
            p3Body: !!document.querySelector('dialog[open] #p3body')
        };
    });
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

test.describe('#B995 a click inside a dual-role trigger (legacy trigger + close button)', () => {

    test('01 a click on a node added inside the trigger after bindOpen dispatches it once and opens P3', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs, p3Before } = await openScene(page);
        await page.evaluate(() => {
            var b = document.createElement('b');
            b.className = 'late';
            b.textContent = ' late';
            b.style.display = 'inline-block';
            b.style.padding = '4px';
            document.querySelector('[data-probe="dual"]').appendChild(b);
        });
        await page.click('[data-probe="dual"] b.late', { force: true });
        await page.waitForTimeout(900);
        const s = await readState(page);
        console.log('[B995 01]', JSON.stringify(s), 'p3 GETs', reqs.p3 - p3Before, 'prefix-bundle hits', routeHits.n);
        expect(s.dispatches, 'the trigger was dispatched once').toBe(1);
        expect(reqs.p3 - p3Before, 'P3 was requested once').toBe(1);
        expect(s.p3Open).toBe(true);
        expect(s.p3Body).toBe(true);
        expect(s.p1Open, 'the dual-role element does not close P1').toBe(true);
        expect(errors).toEqual([]);
    });

    test('02 CONTROL a click on the trigger itself dispatches it once', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs, p3Before } = await openScene(page);
        await page.click('[data-probe="dual"]', { position: { x: 3, y: 3 }, force: true });
        await page.waitForTimeout(900);
        const s = await readState(page);
        console.log('[B995 02]', JSON.stringify(s), 'p3 GETs', reqs.p3 - p3Before, 'prefix-bundle hits', routeHits.n);
        expect(s.dispatches).toBe(1);
        expect(reqs.p3 - p3Before).toBe(1);
        expect(s.p3Open).toBe(true);
        expect(s.p1Open).toBe(true);
        expect(errors).toEqual([]);
    });

    test('03 CONTROL a click on markup present when bindOpen ran dispatches it once', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs, p3Before } = await openScene(page);
        await page.click('[data-probe="dual"] span.nest', { force: true });
        await page.waitForTimeout(900);
        const s = await readState(page);
        console.log('[B995 03]', JSON.stringify(s), 'p3 GETs', reqs.p3 - p3Before, 'prefix-bundle hits', routeHits.n);
        expect(s.dispatches).toBe(1);
        expect(reqs.p3 - p3Before).toBe(1);
        expect(s.p3Open).toBe(true);
        expect(s.p1Open).toBe(true);
        expect(errors).toEqual([]);
    });
});
