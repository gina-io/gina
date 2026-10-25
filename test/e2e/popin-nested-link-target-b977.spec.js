'use strict';

/**
 * Playwright RUNTIME e2e for #B977 — a click on an element INSIDE an `<a target="…">` in popin content.
 *
 * The popin guide promises that a link with a `target` opens that window as usual, while a plain link
 * (no `id`, no `#` in its URL, no `target`) loads its page into the same popin. `register()`'s click
 * listener is bound on the link, but it read `href` and `target` from `event.target`, the node the user
 * clicked: a click on a `<span>` (an icon, a label) inside a `target` link read no `target`, took the
 * in-popin branch and loaded the link's page into the popin instead of opening its window.
 *
 * Arms (`window.open` is stubbed and records each call; the routes count their requests):
 *   01 a click on a span inside `<a target="_blank">` opens that window, and nothing loads into the popin
 *   02 a click on an element two levels inside `<a target="extwin">` opens that window
 *   03 CONTROL — a click on the `<a target="_blank">` itself opens that window
 *   04 CONTROL — a click on a span inside a plain `<a href>` still loads its page into the popin
 *
 * Subtract lever: B977_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle URL
 * (page.route, zero disk mutation); `routeHits` counts the copies served, and `openScene` asserts at least one
 * whenever the lever is set.
 *
 * Run:
 *   npx playwright test test/e2e/popin-nested-link-target-b977.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>nested link target</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>nested link target</h1>'
    + '<button id="trig-d" data-gina-dialog="D" data-gina-dialog-src="/b977/frag" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open D</button>'
    + '</body></html>';

const FRAG = '<div id="frag"><p id="frag-text">content</p>'
    + '<a class="ext" href="/b977/ext" target="_blank">ext</a> '
    + '<a class="nested" href="/b977/ext" target="_blank"><span class="in">nested</span></a> '
    + '<a class="deep" href="/b977/ext2" target="extwin"><span><b class="deepb">deep</b></span></a> '
    + '<a class="plain" href="/b977/fragB"><span class="pin">plain</span></a> '
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_B = '<div id="fragB"><p>B content</p><button class="gina-popin-close" type="button">Close</button></div>';
const EXT = '<div id="ext"><p>loaded into the popin</p></div>';

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B977_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B977_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/** Load the page, open popin D on its fragment, stub window.open. Returns the request counters. */
async function openScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { ext: 0, ext2: 0, fragB: 0 };
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
    await page.route('**/b977', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b977/frag', (r) => r.fulfill(html(FRAG)));
    await page.route('**/b977/fragB', (r) => { reqs.fragB++; return r.fulfill(html(FRAG_B)); });
    await page.route('**/b977/ext', (r) => { reqs.ext++; return r.fulfill(html(EXT)); });
    await page.route('**/b977/ext2', (r) => { reqs.ext2++; return r.fulfill(html(EXT)); });
    await page.goto(BASE + '/b977');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    if (process.env.B977_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B977_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.click('#trig-d');
    await page.waitForSelector('dialog[open] #frag', { timeout: 8000 });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
        window.__b977opens = [];
        window.open = function (u, t) { window.__b977opens.push([String(u), String(t)]); return null; };
    });
    return { routeHits, reqs };
}

function readState(page) {
    return page.evaluate(() => {
        var p = window.gina.popin.getPopinByName('D');
        var el = p ? document.getElementById(p.id) : null;
        return {
            opens: window.__b977opens.slice(),
            isOpen: !!(p && p.isOpen === true),
            isRedirecting: !!(p && p.isRedirecting === true),
            frag: !!(el && el.querySelector('#frag')),
            fragB: !!(el && el.querySelector('#fragB')),
            ext: !!(el && el.querySelector('#ext'))
        };
    });
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

test.describe('#B977 a click inside a link with a target, in popin content', () => {

    test('01 a click on a span inside <a target="_blank"> opens that window, and nothing loads into the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.nested span.in');
        await page.waitForTimeout(600);
        const s = await readState(page);
        console.log('[B977 01]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(s.opens, 'one window opened, with the link\'s href and target').toEqual([['/b977/ext', '_blank']]);
        expect(reqs.ext, 'the link\'s page was not requested into the popin').toBe(0);
        expect(s.frag, 'the popin keeps its content').toBe(true);
        expect(s.ext).toBe(false);
        expect(s.isRedirecting, 'no load is in progress in this popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('02 a click on an element two levels inside <a target="extwin"> opens that window', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.deep b.deepb');
        await page.waitForTimeout(600);
        const s = await readState(page);
        console.log('[B977 02]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(s.opens).toEqual([['/b977/ext2', 'extwin']]);
        expect(reqs.ext2).toBe(0);
        expect(s.frag).toBe(true);
        expect(s.ext).toBe(false);
        expect(errors).toEqual([]);
    });

    test('03 CONTROL a click on the <a target="_blank"> itself opens that window', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.ext');
        await page.waitForTimeout(600);
        const s = await readState(page);
        console.log('[B977 03]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(s.opens).toEqual([['/b977/ext', '_blank']]);
        expect(reqs.ext).toBe(0);
        expect(s.frag).toBe(true);
        expect(errors).toEqual([]);
    });

    test('04 CONTROL a click on a span inside a plain <a href> still loads its page into the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.plain span.pin');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(300);
        const s = await readState(page);
        console.log('[B977 04]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(s.opens, 'no window opened').toEqual([]);
        expect(reqs.fragB, 'the plain link\'s page was requested once').toBe(1);
        expect(s.fragB).toBe(true);
        expect(s.isOpen).toBe(true);
        expect(errors).toEqual([]);
    });
});
