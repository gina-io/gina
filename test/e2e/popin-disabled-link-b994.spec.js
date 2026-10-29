'use strict';

/**
 * Playwright RUNTIME e2e for #B994 (+ #B1007, #B1008) — an element carrying `disabled` in popin content does
 * nothing when clicked, wherever the click lands on it.
 *
 * Before the fix no shape of it was honored: a link carrying `disabled` when the content was bound was never
 * bound, so the browser followed it (#B1008); on a link disabled after the bind, register()'s click gate read
 * `disabled` from the node clicked, so a click on its child loaded the link into the popin (#B994), and a
 * click on the link itself, although ignored, left `$popin.isRedirecting` set, after which
 * `gina.popin.close(name)` did nothing (#B1007). The gate serves close buttons too: a click on a child of a
 * disabled close element closed the popin.
 *
 * Arms (the routes count requests by resource type, so a navigation reads `document` and a popin load `xhr`):
 *   01 a link disabled at bind time: a click on its child neither navigates nor loads, and the popin stays
 *   02 the same link once `disabled` is removed: a click loads it into the popin
 *   03 a link disabled after the bind: a click on its child loads nothing
 *   04 a link disabled after the bind: a click on the link loads nothing, and gina.popin.close() still works
 *   05 a disabled close element: a click on its child does not close the popin
 *   06 CONTROL a click on a plain link's child loads it into the popin
 *   07 CONTROL an enabled close button closes the popin
 *   08 a disabled <a> with no href is left as written (no href, no id, not focusable), and once `disabled` is
 *      removed a click on it leaves gina.popin.close() working: the bind loop still skips it, as before
 *   09 a link with a target disabled at bind time: a click on its child opens no window
 *
 * Subtract lever: B994_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle URL
 * (page.route, zero disk mutation); `routeHits` counts the copies served, and `openScene` asserts at least one
 * whenever the lever is set.
 *
 * Run:
 *   npx playwright test test/e2e/popin-disabled-link-b994.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>disabled popin links</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>disabled popin links</h1>'
    + '<button id="trig-d" type="button" data-gina-dialog="D" data-gina-dialog-src="/b994/frag" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open D</button>'
    + '</body></html>';

const PAD = ' style="display:inline-block;padding:10px"';
const FRAG = '<div id="frag"><p id="frag-text">content</p>'
    + '<a class="dbind" href="/b994/bound"' + PAD + ' disabled><span class="dbind-in">disabled at bind</span></a> '
    + '<a class="late" href="/b994/late"' + PAD + '><span class="late-in">disabled later</span></a> '
    + '<a class="plain" href="/b994/plain"><span class="pin">plain</span></a> '
    + '<span class="gina-popin-close dclose" disabled' + PAD + '><b class="dclose-in">x</b></span> '
    + '<a class="dnohref" disabled' + PAD + '><span class="dnohref-in">no href</span></a> '
    + '<a class="dtarget" href="/b994/target" target="b994win" disabled' + PAD + '><span class="dtarget-in">target</span></a> '
    + '<button class="gina-popin-close eclose" type="button">Close</button></div>';
const LOADED = (id) => '<div id="' + id + '"><p>loaded into the popin</p></div>';

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B994_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B994_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/** Load the page and open popin D on its fragment. Returns the request counters. */
async function openScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { bound: [], late: [], plain: [] };
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
    const rec = (k, body) => (r) => { reqs[k].push(r.request().resourceType()); return r.fulfill(html(body)); };
    await page.route('**/b994', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b994/frag', (r) => r.fulfill(html(FRAG)));
    await page.route('**/b994/bound', rec('bound', LOADED('boundBody')));
    await page.route('**/b994/late', rec('late', LOADED('lateBody')));
    await page.route('**/b994/plain', rec('plain', LOADED('plainBody')));
    await page.goto(BASE + '/b994');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    if (process.env.B994_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B994_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.click('#trig-d');
    await page.waitForSelector('dialog[open] #frag', { timeout: 8000 });
    await page.waitForTimeout(200);
    return { routeHits, reqs };
}

function readState(page) {
    return page.evaluate(() => {
        var p = window.gina && window.gina.popin && window.gina.popin.getPopinByName('D');
        var el = p ? document.getElementById(p.id) : null;
        return {
            path: location.pathname,
            isOpen: !!(p && p.isOpen === true),
            isRedirecting: !!(p && p.isRedirecting === true),
            frag: !!(el && el.querySelector('#frag')),
            loaded: el ? ['boundBody', 'lateBody', 'plainBody'].filter(function (id) { return !!el.querySelector('#' + id); }) : null
        };
    });
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

const disableLate = (page) => page.evaluate(() => document.querySelector('dialog[open] #frag a.late').setAttribute('disabled', ''));

test.describe('#B994 an element carrying disabled in popin content does nothing when clicked', () => {

    test('01 a link disabled at bind time: a click on its child neither navigates nor loads, and the popin stays', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.dbind span.dbind-in');
        await page.waitForTimeout(800);
        const s = await readState(page);
        console.log('[B994 01]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.bound, 'the link was neither followed nor loaded').toEqual([]);
        expect(s.path).toBe('/b994');
        expect(s.frag, 'the popin keeps its content').toBe(true);
        expect(s.isOpen).toBe(true);
        expect(errors).toEqual([]);
    });

    test('02 the same link once disabled is removed: a click loads it into the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.evaluate(() => document.querySelector('dialog[open] #frag a.dbind').removeAttribute('disabled'));
        await page.click('dialog[open] #frag a.dbind', { position: { x: 2, y: 2 } });
        await page.waitForSelector('dialog[open] #boundBody', { timeout: 8000 });
        const s = await readState(page);
        console.log('[B994 02]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.bound, 'loaded into the popin, not followed by the browser').toEqual(['xhr']);
        expect(s.path).toBe('/b994');
        expect(errors).toEqual([]);
    });

    test('03 a link disabled after the bind: a click on its child loads nothing', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await disableLate(page);
        await page.click('dialog[open] #frag a.late span.late-in');
        await page.waitForTimeout(800);
        const s = await readState(page);
        console.log('[B994 03]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.late).toEqual([]);
        expect(s.frag).toBe(true);
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(errors).toEqual([]);
    });

    test('04 a link disabled after the bind: a click on the link loads nothing, and gina.popin.close() still works', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await disableLate(page);
        await page.click('dialog[open] #frag a.late', { position: { x: 2, y: 2 } });
        await page.waitForTimeout(800);
        const s = await readState(page);
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(500);
        const after = await readState(page);
        console.log('[B994 04]', JSON.stringify(s), 'after close', JSON.stringify(after), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.late).toEqual([]);
        expect(s.frag).toBe(true);
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('05 a disabled close element: a click on its child does not close the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        await page.click('dialog[open] #frag span.dclose b.dclose-in');
        await page.waitForTimeout(800);
        const s = await readState(page);
        console.log('[B994 05]', JSON.stringify(s), 'prefix-bundle hits', routeHits.n);
        expect(s.isOpen).toBe(true);
        expect(s.frag).toBe(true);
        expect(errors).toEqual([]);
    });

    test('06 CONTROL a click on a plain link\'s child loads it into the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.plain span.pin');
        await page.waitForSelector('dialog[open] #plainBody', { timeout: 8000 });
        const s = await readState(page);
        console.log('[B994 06]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.plain).toEqual(['xhr']);
        expect(s.isOpen).toBe(true);
        expect(errors).toEqual([]);
    });

    test('07 CONTROL an enabled close button closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        await page.click('dialog[open] #frag button.eclose');
        await page.waitForTimeout(800);
        const s = await readState(page);
        console.log('[B994 07]', JSON.stringify(s), 'prefix-bundle hits', routeHits.n);
        expect(s.isOpen).toBe(false);
        expect(errors).toEqual([]);
    });

    test('08 a disabled <a> with no href is left as written, and once re-enabled its click keeps gina.popin.close() working', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        const attrs = await page.evaluate(() => {
            var a = document.querySelector('dialog[open] #frag a.dnohref');
            a.focus();
            return { href: a.getAttribute('href'), id: a.id, isLink: a.getAttribute('data-gina-popin-is-link'), focused: document.activeElement === a };
        });
        await page.evaluate(() => document.querySelector('dialog[open] #frag a.dnohref').removeAttribute('disabled'));
        await page.click('dialog[open] #frag a.dnohref', { position: { x: 2, y: 2 } });
        await page.waitForTimeout(600);
        const s = await readState(page);
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(500);
        const after = await readState(page);
        console.log('[B994 08]', JSON.stringify(attrs), JSON.stringify(s), 'after close', JSON.stringify(after), 'prefix-bundle hits', routeHits.n);
        expect(attrs, 'no href, no id, no popin bookkeeping, not focusable').toEqual({ href: null, id: '', isLink: null, focused: false });
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('09 a link with a target disabled at bind time: a click on its child opens no window', async ({ page }) => {
        const errors = collectPageErrors(page);
        const popups = [];
        page.on('popup', (p) => popups.push(p.url()));
        const { routeHits } = await openScene(page);
        await page.click('dialog[open] #frag a.dtarget span.dtarget-in');
        await page.waitForTimeout(800);
        const s = await readState(page);
        console.log('[B994 09]', JSON.stringify(s), 'popups', JSON.stringify(popups), 'prefix-bundle hits', routeHits.n);
        expect(popups, 'no window was opened').toEqual([]);
        expect(s.path).toBe('/b994');
        expect(s.frag).toBe(true);
        expect(errors).toEqual([]);
    });
});
