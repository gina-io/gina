'use strict';

/**
 * Playwright RUNTIME e2e for #B1012 — a click on an enabled `<a>` with no `href` in popin content left
 * `$popin.isRedirecting` set, so `gina.popin.close(name)` and a form's `close()` did nothing afterwards.
 *
 * popinBind gives such an anchor `href="#"` and binds it as an action, which loads nothing; the link's own click
 * listener, attached because that `href="#"` passed its test, set the flag anyway. The listener is now attached
 * only to an anchor that had an `href` of its own. In a popin registered with the validator, the same listener
 * also appended the inherited data of the form around the anchor to its `href`; an action anchor now keeps `#`,
 * while a link in that form still carries the data.
 *
 * Arms (the routes count requests by resource type, so a popin load reads `xhr`):
 *   01 an enabled <a> with no href: its click starts no redirect, and gina.popin.close() closes the popin
 *   02 an <a href="">: the same
 *   03 an <a> with no href whose own click handler calls gina.popin.close(): the popin closes
 *   04 CONTROL no click: gina.popin.close() closes the popin
 *   05 CONTROL a plain link's click loads it into the popin
 *   06 a popin registered with the validator: an <a> with no href inside a form carrying
 *      data-gina-form-inherits-data keeps `href="#"` when clicked, and gina.popin.close() closes the popin
 *   07 CONTROL the same popin: a link inside that form loads with the inherited data in its query
 *
 * Subtract lever: B1012_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle URL
 * (page.route, zero disk mutation); `routeHits` counts the copies served, and each scene asserts at least one
 * whenever the lever is set.
 *
 * Run:
 *   npx playwright test test/e2e/popin-href-less-link-b1012.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

/** A page loading the built bundle; `onload` picks the onload script ('' or '.hform', whose forms whisper turns the validator on). */
const page_ = (title, onload, body) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload' + onload + '.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>' + title + '</h1>' + body + '</body></html>';

const PAGE = page_('href-less popin links', '',
    '<button id="trig-d" type="button" data-gina-dialog="D" data-gina-dialog-src="/b1012/frag" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open D</button>');
// the validator scene: popin V is registered WITH the validator, the only way its forms are bound (and its link
// listener's inherited-data branch runs); its legacy trigger is selected by name, since its id is rewritten
const PAGE_V = page_('href-less popin links (validator)', '.hform',
    '<button type="button" data-gina-popin-name="V" data-gina-popin-url="/b1012/vfrag" data-gina-dialog-preload="false">Open V</button>');

const PAD = ' style="display:inline-block;padding:10px"';
const FRAG = '<div id="frag"><p id="frag-text">content</p>'
    + '<a class="nohref"' + PAD + '><span>no href</span></a> '
    + '<a class="emptyhref" href=""' + PAD + '><span>empty href</span></a> '
    + '<a class="closer"' + PAD + '><span>no href, closes</span></a> '
    + '<a class="plain" href="/b1012/plain"' + PAD + '><span>plain</span></a> '
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const VFRAG = '<div id="vfrag">'
    + '<form id="vform" data-gina-form-rule="vform" data-gina-form-inherits-data="%7B%22k%22%3A1%7D" action="/b1012/vsave" method="post">'
    + '<input type="text" name="q" value="x">'
    + '<a class="vnohref"' + PAD + '><span>no href</span></a> '
    + '<a class="vlink" href="/b1012/vnext"' + PAD + '><span>link</span></a></form>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const LOADED = (id) => '<div id="' + id + '"><p>loaded into the popin</p></div>';

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B1012_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1012_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });

/** Load the page and open popin D on its fragment. Returns the request counters. */
async function openScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { plain: [] };
    await page.route('**/b1012', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b1012/frag', (r) => r.fulfill(html(FRAG)));
    await page.route('**/b1012/plain', (r) => { reqs.plain.push(r.request().resourceType()); return r.fulfill(html(LOADED('plainBody'))); });
    await page.goto(BASE + '/b1012');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    if (process.env.B1012_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B1012_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.click('#trig-d');
    await page.waitForSelector('dialog[open] #frag', { timeout: 8000 });
    await page.waitForTimeout(200);
    return { routeHits, reqs };
}

/** Load the validator page, register popin V with the validator, and open it. Returns the request counters. */
async function openSceneV(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { vnext: [] };
    await page.route('**/b1012v', (r) => r.fulfill(html(PAGE_V)));
    await page.route('**/b1012/vfrag', (r) => r.fulfill(html(VFRAG)));
    await page.route(/\/b1012\/vnext(\?.*)?$/, (r) => {
        reqs.vnext.push(r.request().resourceType() + ' ' + r.request().url().replace(BASE, ''));
        return r.fulfill(html(LOADED('vnextBody')));
    });
    await page.goto(BASE + '/b1012v');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && window.gina.validator),
        null,
        { timeout: 15000 }
    );
    if (process.env.B1012_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B1012_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'V', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'popin V must register').toBe('READY');
    await page.click('[data-gina-popin-name="V"]');
    await page.waitForSelector('dialog[open] #vfrag', { timeout: 8000 });
    await page.waitForTimeout(200);
    // scene control: the popin holds a bound form, so its link listener's inherited-data branch can run
    expect(await page.evaluate(() => window.gina.popin.getPopinByName('V').hasForm), 'popin V has a bound form').toBe(true);
    return { routeHits, reqs };
}

function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina && window.gina.popin && window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        return {
            path: location.pathname,
            isOpen: !!(p && p.isOpen === true),
            isRedirecting: !!(p && p.isRedirecting === true),
            loaded: el ? ['plainBody', 'vnextBody'].filter(function (id) { return !!el.querySelector('#' + id); }) : null
        };
    }, name);
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

const close = (page, name) => page.evaluate((n) => window.gina.popin.close(n), name);

/** Click `selector` in popin D, then close D by the API; returns the state after the click and after the close. */
async function clickThenClose(page, selector) {
    await page.click('dialog[open] #frag ' + selector, { position: { x: 2, y: 2 } });
    await page.waitForTimeout(600);
    const s = await readState(page, 'D');
    await close(page, 'D');
    await page.waitForTimeout(500);
    return { s, after: await readState(page, 'D') };
}

test.describe('#B1012 a click on an <a> with no href in popin content leaves the popin closable', () => {

    test('01 an enabled <a> with no href: its click starts no redirect, and gina.popin.close() closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        const { s, after } = await clickThenClose(page, 'a.nohref');
        console.log('[B1012 01]', JSON.stringify(s), 'after close', JSON.stringify(after), 'prefix-bundle hits', routeHits.n);
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('02 an <a href="">: its click starts no redirect, and gina.popin.close() closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        const { s, after } = await clickThenClose(page, 'a.emptyhref');
        console.log('[B1012 02]', JSON.stringify(s), 'after close', JSON.stringify(after), 'prefix-bundle hits', routeHits.n);
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('03 an <a> with no href whose own click handler calls gina.popin.close(): the popin closes', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        await page.evaluate(() => {
            document.querySelector('dialog[open] #frag a.closer').addEventListener('click', function () { window.gina.popin.close('D'); });
        });
        await page.click('dialog[open] #frag a.closer', { position: { x: 2, y: 2 } });
        await page.waitForTimeout(800);
        const s = await readState(page, 'D');
        console.log('[B1012 03]', JSON.stringify(s), 'prefix-bundle hits', routeHits.n);
        expect(s.isOpen, 'the handler\'s close closed the popin').toBe(false);
        expect(s.isRedirecting).toBe(false);
        expect(errors).toEqual([]);
    });

    test('04 CONTROL no click: gina.popin.close() closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openScene(page);
        await close(page, 'D');
        await page.waitForTimeout(500);
        const s = await readState(page, 'D');
        console.log('[B1012 04]', JSON.stringify(s), 'prefix-bundle hits', routeHits.n);
        expect(s.isOpen).toBe(false);
        expect(errors).toEqual([]);
    });

    test('05 CONTROL a plain link\'s click loads it into the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.plain', { position: { x: 2, y: 2 } });
        await page.waitForSelector('dialog[open] #plainBody', { timeout: 8000 });
        const s = await readState(page, 'D');
        console.log('[B1012 05]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.plain).toEqual(['xhr']);
        expect(s.path).toBe('/b1012');
        expect(s.isOpen).toBe(true);
        expect(errors).toEqual([]);
    });

    test('06 a popin registered with the validator: an <a> with no href in a form carrying inherited data keeps href="#", and gina.popin.close() closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits } = await openSceneV(page);
        await page.click('dialog[open] #vfrag a.vnohref', { position: { x: 2, y: 2 } });
        await page.waitForTimeout(600);
        const href = await page.evaluate(() => document.querySelector('#vfrag a.vnohref').getAttribute('href'));
        const s = await readState(page, 'V');
        await close(page, 'V');
        await page.waitForTimeout(500);
        const after = await readState(page, 'V');
        console.log('[B1012 06]', 'href', href, JSON.stringify(s), 'after close', JSON.stringify(after), 'prefix-bundle hits', routeHits.n);
        expect(href, 'the action anchor keeps its href').toBe('#');
        expect(s.isRedirecting, 'no redirect was started').toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(errors).toEqual([]);
    });

    test('07 CONTROL the same popin: a link inside that form loads with the inherited data in its query', async ({ page }) => {
        const errors = collectPageErrors(page);
        const { routeHits, reqs } = await openSceneV(page);
        await page.click('dialog[open] #vfrag a.vlink', { position: { x: 2, y: 2 } });
        await page.waitForSelector('dialog[open] #vnextBody', { timeout: 8000 });
        const s = await readState(page, 'V');
        console.log('[B1012 07]', JSON.stringify(s), 'reqs', JSON.stringify(reqs), 'prefix-bundle hits', routeHits.n);
        expect(reqs.vnext).toEqual(['xhr /b1012/vnext?inheritedData=%7B%22k%22%3A1%7D']);
        expect(s.isOpen).toBe(true);
        expect(errors).toEqual([]);
    });
});
