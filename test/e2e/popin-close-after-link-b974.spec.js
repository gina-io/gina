'use strict';

/**
 * Playwright RUNTIME e2e for #B974 + #B975 — closing a popin after (or during) a load that a
 * plain link inside it started.
 *
 * A plain `<a href>` inside popin content (no target, no id) loads its page into the SAME popin:
 * its click sets `$popin.isRedirecting = true`, and an HTML landing keeps it true
 * (`popinLoadContent(result, true)`). `popinClose()` returns early while `isRedirecting` is
 * true — a guard the validator's same-popin redirect relies on — and only the close button
 * resets the flag before closing.
 *
 *   #B974 — a native Escape on a modal popin closes the `<dialog>` and calls `popinClose()`
 *           through the native close sync, which returns: no `close.<id>`, `isOpen` and
 *           `activePopinId` stay set, and the next click on the trigger never shows the dialog.
 *           A non-modal popin's Escape shim calls `popinClose()` too, and the dialog stays open.
 *   #B975 — `popinClose()` holds no `_loadSeq` bump: a close while such a load is in flight lets
 *           the landing come back into the dismissed popin.
 *
 * Arms:
 *   01 modal legacy trigger: link load, then Escape — closes, fires close.<id>, the trigger re-opens it
 *   02 CONTROL — the same popin closed by Escape with no link load
 *   03 CONTROL — the link load, then the close button (it resets the flag itself)
 *   04 modal declarative trigger: link load, then Escape
 *   05 non-modal declarative trigger: link load, then Escape (the shim's path)
 *   06 the close button while the link's load is still in flight: the landing is dropped
 *   07 Escape while the link's load is still in flight: closed, and the landing is dropped
 *   08 / 09 the same two closes on a modal declarative trigger
 *   10 after a link load, gina.popin.close(name) — the call a client navigation makes
 *   11 the same after a link load that FAILED (500)
 *   12 after a link that opens ANOTHER window (a target attribute): no load ever settles its flag
 *   13 after gina.popin.load() reloads an OPEN popin (no link involved)
 *   14 after a link load into a PARTIAL-target popin (the landing takes the loaded.<id> branch)
 *   15 the validator's redirect into the SAME popin: it stays open through the redirect (the
 *      guard it relies on — must hold on both sides of the fix), then gina.popin.close(name)
 *
 * Subtract lever: B974_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the
 * bundle URL (page.route, zero disk mutation); `routeHits` is the evidence it executed.
 *
 * Run:
 *   npx playwright test test/e2e/popin-close-after-link-b974.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;
const SLOW_MS = 1500;
// a legacy trigger's authored id is rewritten to `popin.click.<id>` when its popin registers,
// so it is selected by its name attribute
const LEGACY = '[data-gina-popin-name="L"]';

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>close after link</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>close after link</h1>'
    + '<button id="trig-l" data-gina-popin-name="L" data-gina-popin-url="/b974/fragA">Open L</button>'
    + '<button id="trig-d" data-gina-dialog="D" data-gina-dialog-src="/b974/fragA" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open D</button>'
    + '<button id="trig-n" data-gina-dialog="N" data-gina-dialog-src="/b974/fragA" data-gina-dialog-preload="false">Open N</button>'
    + '<button id="trig-p" data-gina-dialog="P" data-gina-dialog-src="/b974/fragP" data-gina-dialog-target="#slot" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open P</button>'
    + '</body></html>';

const FRAG_A = '<div id="fragA"><p id="fragA-text">A content</p>'
    + '<a href="/b974/fragB">next</a> <a href="/b974/fragSlow" class="slow">slow</a>'
    + ' <button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_B = '<div id="fragB"><p>B content</p><button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_SLOW = '<div id="fragSlow"><p>slow content</p><button class="gina-popin-close" type="button">Close</button></div>';
// a partial-target popin: the link inside the slot reloads the slot only
const FRAG_P = '<div id="fragP"><div id="slot"><p id="slotA">slot A</p><a href="/b974/fragP2">next</a></div>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_P2 = '<div id="fragP"><div id="slot"><p id="slotB">slot B</p></div></div>';

// the validator scene (arm 15): a form inside popin V answers a redirect into the same popin
const PAGE_V = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>redirect in place</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.hform.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>redirect in place</h1>'
    + '<button data-gina-popin-name="V" data-gina-popin-url="/b974/vfrag" data-gina-dialog-preload="false">Open V</button>'
    + '</body></html>';
const FRAG_V = '<div id="vfrag"><form id="vform" data-gina-form-rule="vform" action="/b974/vsave" method="post">'
    + '<input name="ref" value="in-popin"><button id="vform-submit" type="submit">Save</button></form>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B974_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B974_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

async function gotoScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
    await page.route('**/b974', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b974/fragA', (r) => r.fulfill(html(FRAG_A)));
    await page.route('**/b974/fragB', (r) => r.fulfill(html(FRAG_B)));
    await page.route('**/b974/fragSlow', async (r) => {
        await new Promise((res) => setTimeout(res, SLOW_MS));
        try { await r.fulfill(html(FRAG_SLOW)); } catch (e) { /* the request was aborted */ }
    });
    await page.route('**/b974/fragP', (r) => r.fulfill(html(FRAG_P)));
    await page.route('**/b974/fragP2', (r) => r.fulfill(html(FRAG_P2)));
    await page.goto(BASE + '/b974');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    // the legacy trigger works only once its popin is constructed
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'L' }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'the legacy popin must register').toBe('READY');
    return routeHits;
}

/** The validator scene: popin V registered WITH the validator, so the form it loads is bound. */
async function gotoSceneV(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
    await page.route('**/b974v', (r) => r.fulfill(html(PAGE_V)));
    await page.route('**/b974/vfrag', (r) => r.fulfill(html(FRAG_V)));
    await page.route('**/b974/vsave', (r) => r.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: '{"popin":{"location":"/b974/fragB"}}'
    }));
    await page.route('**/b974/fragB', (r) => r.fulfill(html(FRAG_B)));
    await page.goto(BASE + '/b974v');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && window.gina.validator),
        null,
        { timeout: 15000 }
    );
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'V', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'popin V must register').toBe('READY');
    return routeHits;
}

/** Count close.<id> of popin `name` from now on. */
async function watchCloses(page, name) {
    await page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        window.__b974 = { closes: 0 };
        document.addEventListener('close.' + p.id, function () { window.__b974.closes++; }, true);
    }, name);
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

/** Open through `selector` and wait for fragment A in an open dialog; count close.<id> from then on. */
async function openAndWatch(page, selector, name) {
    await page.click(selector);
    await page.waitForSelector('dialog[open] #fragA', { timeout: 8000 });
    await page.waitForTimeout(150);
    await page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        window.__b974 = { closes: 0 };
        document.addEventListener('close.' + p.id, function () { window.__b974.closes++; }, true);
    }, name);
}

function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        return {
            isOpen: !!(p && p.isOpen === true),
            isRedirecting: !!(p && p.isRedirecting === true),
            isLoading: !!(p && p.isLoading === true),
            active: window.gina.popin.activePopinId === (p && p.id),
            dialogOpen: !!(el && el.hasAttribute('open')),
            closes: window.__b974 ? window.__b974.closes : -1,
            fragA: !!(el && el.querySelector('#fragA')),
            fragB: !!(el && el.querySelector('#fragB')),
            fragSlow: !!document.querySelector('#fragSlow'),
            openDialogs: document.querySelectorAll('dialog[open]').length
        };
    }, name);
}

/** Click the in-dialog link `linkSelector` (a plain anchor in fragment A). */
async function clickInDialogLink(page, linkSelector) {
    await page.click('dialog[open] #fragA ' + linkSelector);
}

/** The trigger opens the popin again, showing fragment A. */
async function reopens(page, selector) {
    await page.click(selector);
    try {
        await page.waitForSelector('dialog[open] #fragA', { timeout: 5000 });
        return true;
    } catch (e) {
        return false;
    }
}

test.describe('#B974 / #B975 — closing a popin after a link inside it loaded a page', () => {

    test('01 modal legacy trigger: link load, then Escape — the popin closes and the trigger re-opens it', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, LEGACY, 'L');
        await clickInDialogLink(page, 'a[href$="/fragB"]');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        const loaded = await readState(page, 'L');
        expect(loaded.isOpen, 'open after the link load').toBe(true);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'L');
        console.log('[B974 01] after the link load', JSON.stringify(loaded), 'after Escape', JSON.stringify(closed));
        expect(closed.dialogOpen, 'the browser closed the dialog').toBe(false);
        expect(closed.isOpen, 'the popin is closed too (RED pre-fix: stays open)').toBe(false);
        expect(closed.closes, 'close.<id> fired once').toBe(1);
        expect(closed.active, 'no longer the active popin').toBe(false);
        expect(await reopens(page, LEGACY), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    });

    test('02 CONTROL — Escape with no link load closes the popin on both sides of the fix', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, LEGACY, 'L');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'L');
        expect(closed.dialogOpen).toBe(false);
        expect(closed.isOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(await reopens(page, LEGACY)).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('03 CONTROL — after a link load, the close button closes the popin on both sides of the fix', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, LEGACY, 'L');
        await clickInDialogLink(page, 'a[href$="/fragB"]');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        await page.click('dialog[open] #fragB .gina-popin-close');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'L');
        expect(closed.dialogOpen).toBe(false);
        expect(closed.isOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(await reopens(page, LEGACY)).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('04 modal declarative trigger: link load, then Escape — the popin closes and the trigger re-opens it', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await clickInDialogLink(page, 'a[href$="/fragB"]');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        console.log('[B974 04] after Escape', JSON.stringify(closed));
        expect(closed.dialogOpen).toBe(false);
        expect(closed.isOpen, 'RED pre-fix: stays open').toBe(false);
        expect(closed.closes).toBe(1);
        expect(await reopens(page, '#trig-d'), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('05 non-modal declarative trigger: link load, then Escape — the popin closes', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-n', 'N');
        await clickInDialogLink(page, 'a[href$="/fragB"]');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        await page.focus('dialog[open] #fragB .gina-popin-close');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'N');
        console.log('[B974 05] after Escape', JSON.stringify(closed));
        expect(closed.dialogOpen, 'RED pre-fix: the dialog stays open').toBe(false);
        expect(closed.isOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('06 the close button while the link\'s load is in flight — the landing is dropped, the popin stays closed', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, LEGACY, 'L');
        await clickInDialogLink(page, 'a.slow');
        await page.waitForTimeout(200);
        await page.click('dialog[open] #fragA .gina-popin-close');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'L');
        await page.waitForTimeout(SLOW_MS + 1000);
        const after = await readState(page, 'L');
        console.log('[B975 06] after the close', JSON.stringify(closed), 'after the landing time', JSON.stringify(after));
        expect(closed.isOpen).toBe(false);
        expect(after.dialogOpen, 'RED pre-fix: the landing re-opens the dialog').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.fragSlow, 'the late body was dropped').toBe(false);
        expect(after.openDialogs).toBe(0);
        expect(await reopens(page, LEGACY), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('07 Escape while the link\'s load is in flight — closed, the landing is dropped', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, LEGACY, 'L');
        await clickInDialogLink(page, 'a.slow');
        await page.waitForTimeout(200);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'L');
        await page.waitForTimeout(SLOW_MS + 1000);
        const after = await readState(page, 'L');
        console.log('[B975 07] after Escape', JSON.stringify(closed), 'after the landing time', JSON.stringify(after));
        expect(closed.dialogOpen).toBe(false);
        expect(closed.isOpen, 'RED pre-fix: stays open').toBe(false);
        expect(after.dialogOpen, 'the landing does not re-open it').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.fragSlow, 'the late body was dropped').toBe(false);
        expect(await reopens(page, LEGACY), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('08 modal declarative trigger: the close button while the link\'s load is in flight — the landing is dropped', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await clickInDialogLink(page, 'a.slow');
        await page.waitForTimeout(200);
        await page.click('dialog[open] #fragA .gina-popin-close');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        await page.waitForTimeout(SLOW_MS + 1000);
        const after = await readState(page, 'D');
        console.log('[B975 08] after the close', JSON.stringify(closed), 'after the landing time', JSON.stringify(after), 'errors', JSON.stringify(errors));
        expect(closed.isOpen).toBe(false);
        expect(after.dialogOpen, 'the landing does not re-open the dialog').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.fragSlow, 'the late body was dropped').toBe(false);
        expect(await reopens(page, '#trig-d'), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('09 modal declarative trigger: Escape while the link\'s load is in flight — closed, the landing is dropped', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await clickInDialogLink(page, 'a.slow');
        await page.waitForTimeout(200);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        await page.waitForTimeout(SLOW_MS + 1000);
        const after = await readState(page, 'D');
        console.log('[B975 09] after Escape', JSON.stringify(closed), 'after the landing time', JSON.stringify(after), 'errors', JSON.stringify(errors));
        expect(closed.dialogOpen).toBe(false);
        expect(closed.isOpen, 'RED pre-fix: stays open').toBe(false);
        expect(after.dialogOpen, 'the landing does not re-open it').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.fragSlow, 'the late body was dropped').toBe(false);
        expect(await reopens(page, '#trig-d'), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('10 after a link load, gina.popin.close(name) — the call a client navigation makes — closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await clickInDialogLink(page, 'a[href$="/fragB"]');
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        console.log('[B974 10] after gina.popin.close', JSON.stringify(closed));
        expect(closed.dialogOpen, 'the dialog is closed').toBe(false);
        expect(closed.isOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(await reopens(page, '#trig-d'), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('11 after a link load that FAILED, gina.popin.close(name) still closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await page.route('**/b974/fragFail', (r) => r.fulfill({ status: 500, contentType: 'text/html; charset=utf-8', body: '<p>boom</p>' }));
        await openAndWatch(page, '#trig-d', 'D');
        await page.evaluate(() => {
            var a = document.createElement('a');
            a.setAttribute('href', '/b974/fragFail');
            a.className = 'fail';
            a.textContent = 'fail';
            document.querySelector('dialog[open] #fragA').appendChild(a);
            window.gina.popin.getPopinByName('D').loadContent(document.querySelector('dialog[open]').innerHTML);
        });
        await page.waitForSelector('dialog[open] #fragA a.fail', { timeout: 8000 });
        await page.click('dialog[open] #fragA a.fail');
        await page.waitForTimeout(600);
        const failed = await readState(page, 'D');
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        console.log('[B974 11] after the failed load', JSON.stringify(failed), 'after gina.popin.close', JSON.stringify(closed));
        expect(failed.isOpen, 'still open on its own content').toBe(true);
        expect(closed.isOpen, 'the API close works after a failed link load').toBe(false);
        expect(closed.dialogOpen).toBe(false);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('12 after a link that opens ANOTHER window (a target attribute), gina.popin.close(name) closes the popin', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await page.evaluate(() => {
            window.__b974opens = [];
            window.open = function (u, t) { window.__b974opens.push(String(t)); return null; };
            var a = document.createElement('a');
            a.setAttribute('href', '/b974/fragExt');
            a.setAttribute('target', '_blank');
            a.className = 'ext';
            a.textContent = 'ext';
            document.querySelector('dialog[open] #fragA').appendChild(a);
            window.gina.popin.getPopinByName('D').loadContent(document.querySelector('dialog[open]').innerHTML);
        });
        await page.waitForSelector('dialog[open] #fragA a.ext', { timeout: 8000 });
        await page.click('dialog[open] #fragA a.ext');
        await page.waitForTimeout(400);
        const after = await readState(page, 'D');
        const opens = await page.evaluate(() => window.__b974opens.slice());
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        console.log('[B974 12] after the click', JSON.stringify(after), 'opens', JSON.stringify(opens), 'after gina.popin.close', JSON.stringify(closed));
        expect(opens, 'the link opened another window').toEqual(['_blank']);
        expect(after.isOpen, 'the popin stays open on its own content').toBe(true);
        expect(after.fragA).toBe(true);
        expect(closed.isOpen, 'RED pre-fix: the flag the link set is never cleared').toBe(false);
        expect(closed.dialogOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('13 after gina.popin.load() reloads an OPEN popin, gina.popin.close(name) closes it', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await openAndWatch(page, '#trig-d', 'D');
        await page.evaluate(() => { window.gina.popin.load('D', '/b974/fragB'); });
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(150);
        const loaded = await readState(page, 'D');
        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'D');
        console.log('[B974 13] after the reload', JSON.stringify(loaded), 'after gina.popin.close', JSON.stringify(closed));
        expect(loaded.isOpen).toBe(true);
        expect(closed.isOpen, 'RED pre-fix: the reload left the flag set').toBe(false);
        expect(closed.dialogOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(await reopens(page, '#trig-d'), 'the trigger opens it again').toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('14 after a link load into a PARTIAL-target popin, gina.popin.close(name) closes it', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await page.click('#trig-p');
        await page.waitForSelector('dialog[open] #slotA', { timeout: 8000 });
        await page.waitForTimeout(150);
        await watchCloses(page, 'P');
        await page.click('dialog[open] #slot a[href$="/fragP2"]');
        await page.waitForSelector('dialog[open] #slotB', { timeout: 8000 });
        await page.waitForTimeout(150);
        const swapped = await page.evaluate(() => ({
            slotB: !!document.querySelector('dialog[open] #slot #slotB'),
            chromeKept: !!document.querySelector('dialog[open] #fragP > .gina-popin-close')
        }));
        const loaded = await readState(page, 'P');
        await page.evaluate(() => window.gina.popin.close('P'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'P');
        console.log('[B974 14] swap', JSON.stringify(swapped), 'after the link load', JSON.stringify(loaded), 'after gina.popin.close', JSON.stringify(closed));
        expect(loaded.isOpen).toBe(true);
        expect(closed.isOpen, 'the API close works after a partial link load').toBe(false);
        expect(closed.dialogOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('15 the validator\'s redirect into the SAME popin keeps it open, then gina.popin.close(name) closes it', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoSceneV(page);
        await page.click('[data-gina-popin-name="V"]');
        await page.waitForFunction(
            () => !!(document.querySelector('dialog[open] #vform') && window.gina.validator.$forms && window.gina.validator.$forms['vform']),
            null,
            { timeout: 8000 }
        );
        await page.waitForTimeout(150);
        await watchCloses(page, 'V');
        const save = page.waitForRequest((r) => r.url().endsWith('/b974/vsave'), { timeout: 5000 });
        await page.click('dialog[open] #vform-submit');
        await save;
        await page.waitForSelector('dialog[open] #fragB', { timeout: 8000 });
        await page.waitForTimeout(300);
        const landed = await readState(page, 'V');
        await page.evaluate(() => window.gina.popin.close('V'));
        await page.waitForTimeout(400);
        const closed = await readState(page, 'V');
        console.log('[B974 15] after the redirect', JSON.stringify(landed), 'after gina.popin.close', JSON.stringify(closed), 'errors', JSON.stringify(errors));
        // the guard the redirect relies on: its own close() is a no-op, so the popin stays open
        // and takes the new body — on both sides of the fix
        expect(landed.isOpen, 'the redirect keeps the popin open').toBe(true);
        expect(landed.dialogOpen).toBe(true);
        expect(landed.closes, 'the redirect did not close the popin').toBe(0);
        expect(closed.isOpen, 'RED pre-fix: the redirect left the flag set').toBe(false);
        expect(closed.dialogOpen).toBe(false);
        expect(closed.closes).toBe(1);
        expect(errors).toEqual([]);
        if (process.env.B974_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });
});
