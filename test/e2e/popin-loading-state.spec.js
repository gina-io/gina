'use strict';

/**
 * Playwright RUNTIME e2e for gh#76 §8 — the `preOpen` loading shell is an explicit state.
 *
 * A `preOpen: true` popin shows a dialog — born modal, a skeleton inside — the moment its
 * XHR is issued. Until the content landed that window had no name: the DOM said open,
 * `isOpen` said closed, and everything keyed on `isOpen` misfired. Now `isLoading` names
 * it, a close during the load is FINAL (the result is dropped, the transport aborted, no
 * `error` for the cancel), a failed load closes the shell unless a listener loaded content
 * into it, and `loadContent()` on the loading popin completes the open instead of throwing.
 *
 * WHY E2E. The defects live in the engine's own <dialog> behaviour (showModal, a native
 * Escape, the `close` event and its timing) and in a real XHR's readyState / abort
 * sequence — jsdom has none of these. The runtime server serves the REAL built bundle; the
 * scene page and its fragments are `page.route`'d (zero fixture footprint), and every load
 * is HELD by its route so the loading window is deterministic rather than raced.
 *
 * Arms (each a control for the others):
 *   §01 a preOpen load that lands: `isLoading` true while held, false after; `isOpen` true; one `open`
 *   §02 `loadContent()` on the loading popin: no throw, content in the dialog, the open completed, one `open`
 *   §03 `gina.popin.close()` during the load: dialog closed, one `close`, no `error`, the release lands NOTHING
 *   §04 a native Escape during the load: the same — the content landing afterwards does NOT re-open it
 *   §05 a failed load with no `error` listener: one `error`, then closed — no spinner left behind
 *   §06 a failed load whose `error` listener loads content: stays open, no `close`
 *   §07 `destroy()` during the load: one `close`, the element gone, the release lands nothing
 *   §08 CONTROL — a popin WITHOUT preOpen never enters the state and opens on landing (both sides)
 *   §09 the adopted-preload path: a close during the adopted wait drops the body when it arrives
 *
 * Red-first: on the pre-change bundle §01–§07 and §09 FAIL and §08 passes (measured — §04's
 * failure is the re-open: the dialog Escape had closed came back when the content landed).
 * Subtract lever: GH76_S4_PREFIX_BUNDLE=<path to a pre-change gina.min.js> serves that file
 * at the bundle URL (page.route, zero disk mutation); `routeHits` is the evidence it ran.
 *
 * Run:
 *   npx playwright test test/e2e/popin-loading-state.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

// The boot kicker (the preOpen harness idiom): a routed page has no server-rendered whisper,
// so poll until the config is there and kick the boot by hand.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>loading state</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>loading state</h1>'
    // B — preOpen, click-time load (preload opted out so the click runs popinLoad, not an adopted warm)
    + '<button id="trig-b" data-gina-dialog="B" data-gina-dialog-src="/fragB" data-gina-dialog-preload="false">Open B</button>'
    // C — the CONTROL: registered WITHOUT preOpen, same trigger shape
    + '<button id="trig-c" data-gina-dialog="C" data-gina-dialog-src="/fragC" data-gina-dialog-preload="false">Open C</button>'
    // D — preOpen with the default hover preload ON: the adopted-preload path (§09)
    + '<button id="trig-d" data-gina-dialog="D" data-gina-dialog-src="/fragD">Open D</button>'
    + '</body></html>';

function frag(name) {
    return '<div id="frag' + name + '"><p>' + name + ' content</p></div>';
}

/** Optional pre-change subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.GH76_S4_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.GH76_S4_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

async function gotoScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    await page.route('**/loading-state', (r) => r.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8', body: PAGE
    }));
    await page.goto(BASE + '/loading-state');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    return routeHits;
}

/**
 * Register the three popins — B and D `preOpen: true`, C without — then install
 * capture-phase counters on `document` for their `open.` / `close.` / `error.` /
 * `destroy.` events (the bus dispatches bubbling CustomEvents on the popin's element or
 * its container; capture on the document sees every one, before any listener could stop it).
 */
async function registerPopins(page) {
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var mk = function (n, opts) {
                return new Promise(function (r) {
                    new Popin(Object.assign({ name: n }, opts)).on('ready', function () { r(n); });
                });
            };
            mk('B', { preOpen: true })
                .then(function () { return mk('C', {}); })
                .then(function () { return mk('D', { preOpen: true }); })
                .then(function () {
                    window.__evt = {};
                    ['B', 'C', 'D'].forEach(function (n) {
                        var p = window.gina.popin.getPopinByName(n);
                        window.__evt[n] = { open: 0, close: 0, error: 0, destroy: 0 };
                        ['open', 'close', 'error', 'destroy'].forEach(function (k) {
                            document.addEventListener(k + '.' + p.id, function () { window.__evt[n][k]++; }, true);
                        });
                    });
                    resolve('READY');
                });
        });
    }));
    expect(reg, 'the three popins must register').toBe('READY');
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

/**
 * Route `/frag<name>` so the request is HELD until release() is called, then fulfilled with
 * `status` (default 200 + the fragment; a 4xx/5xx gets a plain body). A request the client
 * aborted in the meantime has nothing to deliver — the fulfil is allowed to fail quietly.
 */
async function holdRoute(page, name, status) {
    let release;
    const held = new Promise((r) => { release = r; });
    const seen = { n: 0 };
    await page.route('**/frag' + name, async (route) => {
        seen.n++;
        await held;
        try {
            await route.fulfill({
                status: status || 200,
                contentType: 'text/html; charset=utf-8',
                body: (status && status >= 400) ? '<p>boom</p>' : frag(name)
            });
        } catch (e) { /* aborted by the client — nothing to deliver */ }
    });
    return { release: () => release(), seen };
}

/** Everything the window could have touched, for one popin, in one read. */
function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        var trig = document.querySelector('[data-gina-dialog="' + n + '"]');
        return {
            found: !!p,
            isLoading: !!(p && p.isLoading === true),
            isOpen: !!(p && p.isOpen === true),
            elPresent: !!el,
            hasOpenAttr: !!(el && el.hasAttribute('open')),
            skeleton: !!(el && el.querySelector('.gina-popin-skeleton')),
            frag: !!document.getElementById('frag' + n),
            dialogs: document.querySelectorAll('dialog').length,
            triggerDisabled: !!(trig && (trig.disabled || trig.getAttribute('aria-disabled') === 'true')),
            events: (window.__evt && window.__evt[n]) || null
        };
    }, name);
}

/** Click the trigger and wait until the shell is up (the `open` attribute — both sides of the fix show it). */
async function openHeld(page, selector, name) {
    const started = page.waitForRequest((r) => r.url().endsWith('/frag' + name));
    await page.click(selector);
    await started;
    await page.waitForFunction((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p && document.getElementById(p.id);
        return !!(el && el.hasAttribute('open'));
    }, name, { timeout: 8000 });
}

test.describe('gh#76 §8 — the preOpen loading shell is an explicit state (real bundle)', () => {

    test('§01 a preOpen load that lands: isLoading while held, then a real open with one `open` (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B');

        await openHeld(page, '#trig-b', 'B');
        const during = await readState(page, 'B');
        expect(during.hasOpenAttr, 'the shell is showing').toBe(true);
        expect(during.skeleton, 'with the skeleton').toBe(true);
        expect(during.isOpen, 'isOpen stays false until the real open').toBe(false);
        expect(during.isLoading, 'isLoading names the window').toBe(true);
        expect(during.triggerDisabled, 'the trigger is busy').toBe(true);

        h.release();
        await page.waitForFunction(() => !!document.getElementById('fragB'), null, { timeout: 8000 });
        await page.waitForTimeout(150);
        const after = await readState(page, 'B');
        expect(after.isLoading, 'the state is left at the real open').toBe(false);
        expect(after.isOpen).toBe(true);
        expect(after.hasOpenAttr).toBe(true);
        expect(after.skeleton, 'the skeleton is replaced').toBe(false);
        expect(after.events.open, 'exactly one open').toBe(1);
        expect(after.events.close).toBe(0);
        expect(after.events.error).toBe(0);
        expect(after.triggerDisabled, 'the trigger is released').toBe(false);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n, 'the pre-change bundle was not served').toBeGreaterThan(0);
    });

    test('§02 loadContent() on the loading popin lands in the dialog and completes the open — no throw (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B');

        await openHeld(page, '#trig-b', 'B');
        const call = await page.evaluate(() => {
            try {
                window.gina.popin.getPopinByName('B').loadContent('<p id="injected-b">injected</p>');
                return 'OK';
            } catch (e) { return 'THREW: ' + e.message; }
        });
        expect(call, 'loadContent() must not throw while the popin is loading').toBe('OK');
        await page.waitForTimeout(100);
        const injected = await page.evaluate(() => {
            var p = window.gina.popin.getPopinByName('B');
            return !!document.querySelector('#' + p.id + ' #injected-b');
        });
        expect(injected, 'the content landed in the dialog').toBe(true);
        const mid = await readState(page, 'B');
        expect(mid.isOpen, 'the open was completed').toBe(true);
        expect(mid.isLoading).toBe(false);
        expect(mid.events.open).toBe(1);

        // the load still in flight lands afterwards as any second loadContent would (last write wins)
        h.release();
        await page.waitForFunction(() => !!document.getElementById('fragB'), null, { timeout: 8000 });
        await page.waitForTimeout(150);
        const after = await readState(page, 'B');
        expect(after.isOpen).toBe(true);
        expect(after.hasOpenAttr).toBe(true);
        expect(after.events.open, 'still exactly one open').toBe(1);
        expect(after.events.error).toBe(0);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§03 gina.popin.close() during the load is FINAL: closed, one close, no error, the release lands nothing (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B');

        await openHeld(page, '#trig-b', 'B');
        await page.evaluate(() => window.gina.popin.close('B'));
        await page.waitForTimeout(150);
        const mid = await readState(page, 'B');
        expect(mid.hasOpenAttr, 'the shell is closed').toBe(false);
        expect(mid.isLoading, 'the state is left').toBe(false);
        expect(mid.isOpen).toBe(false);
        expect(mid.skeleton, 'the skeleton is gone').toBe(false);
        expect(mid.events.close, 'one close').toBe(1);
        expect(mid.triggerDisabled, 'the trigger is released').toBe(false);

        h.release();
        await page.waitForTimeout(500);
        const after = await readState(page, 'B');
        expect(after.frag, 'the landing content is DROPPED').toBe(false);
        expect(after.hasOpenAttr, 'the dialog did not re-open').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.events.open).toBe(0);
        expect(after.events.close).toBe(1);
        expect(after.events.error, 'the cancel fires no error').toBe(0);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§04 a native Escape during the load routes through the plugin: closed for good, the content landing later does NOT re-open it (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B');

        await openHeld(page, '#trig-b', 'B');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => {
            var p = window.gina.popin.getPopinByName('B');
            var el = p && document.getElementById(p.id);
            return !!(el && !el.hasAttribute('open'));
        }, null, { timeout: 5000 });
        await page.waitForTimeout(150);
        const mid = await readState(page, 'B');
        expect(mid.isLoading, 'the plugin saw the UA close').toBe(false);
        expect(mid.events.close, 'one close').toBe(1);
        expect(mid.triggerDisabled, 'the trigger is released').toBe(false);

        h.release();
        await page.waitForTimeout(500);
        const after = await readState(page, 'B');
        expect(after.hasOpenAttr, 'the dialog the user dismissed must not come back').toBe(false);
        expect(after.frag, 'the landing content is dropped').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.events.open).toBe(0);
        expect(after.events.close).toBe(1);
        expect(after.events.error).toBe(0);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§05 a failed load with no error listener: one error, then the shell closes (RED pre-change: a stuck spinner)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B', 500);

        await openHeld(page, '#trig-b', 'B');
        h.release();
        await page.waitForFunction(() => window.__evt.B.error >= 1, null, { timeout: 8000 });
        await page.waitForTimeout(150);
        const after = await readState(page, 'B');
        expect(after.events.error).toBe(1);
        expect(after.hasOpenAttr, 'no spinner left behind').toBe(false);
        expect(after.isLoading).toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.skeleton).toBe(false);
        expect(after.events.close, 'the loading close fired').toBe(1);
        expect(after.events.open).toBe(0);
        expect(after.triggerDisabled).toBe(false);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§06 a failed load whose error listener loads content keeps the dialog: open, no close (RED pre-change: the listener throws)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B', 500);
        await page.evaluate(() => {
            var p = window.gina.popin.getPopinByName('B');
            p.on('error', function () {
                try { p.loadContent('<p id="err-b">could not load</p>'); }
                catch (e) { window.__listenerThrew = e.message; }
            });
        });

        await openHeld(page, '#trig-b', 'B');
        h.release();
        await page.waitForFunction(() => window.__evt.B.error >= 1, null, { timeout: 8000 });
        await page.waitForTimeout(150);
        const threw = await page.evaluate(() => window.__listenerThrew || null);
        expect(threw, 'loadContent() inside the error listener must not throw').toBe(null);
        const shown = await page.evaluate(() => {
            var p = window.gina.popin.getPopinByName('B');
            return !!document.querySelector('#' + p.id + ' #err-b');
        });
        expect(shown, 'the listener\'s content is in the dialog').toBe(true);
        const after = await readState(page, 'B');
        expect(after.hasOpenAttr, 'the dialog stays open').toBe(true);
        expect(after.isOpen, 'the listener completed the open').toBe(true);
        expect(after.isLoading).toBe(false);
        expect(after.events.error).toBe(1);
        expect(after.events.close, 'nothing closed it').toBe(0);
        expect(after.events.open).toBe(1);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§07 destroy() during the load: one close, the element gone, the release lands nothing (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'B');

        await openHeld(page, '#trig-b', 'B');
        await page.evaluate(() => window.gina.popin.destroy('B'));
        await page.waitForTimeout(150);
        const mid = await readState(page, 'B');
        expect(mid.found, 'unregistered').toBe(false);
        expect(mid.events.close, 'the loading close fired before the teardown').toBe(1);
        expect(mid.events.destroy).toBe(1);
        expect(mid.dialogs, 'no dialog element left').toBe(0);

        h.release();
        await page.waitForTimeout(500);
        const after = await readState(page, 'B');
        expect(after.frag, 'the landing content is dropped').toBe(false);
        expect(after.dialogs, 'no element was re-created for a destroyed popin').toBe(0);
        expect(after.events.open).toBe(0);
        expect(after.events.error).toBe(0);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§08 CONTROL — a popin without preOpen never enters the state and opens when its load lands (both sides)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'C');

        const started = page.waitForRequest((r) => r.url().endsWith('/fragC'));
        await page.click('#trig-c');
        await started;
        await page.waitForTimeout(150);
        const during = await readState(page, 'C');
        expect(during.isLoading, 'no shell, no state').toBe(false);
        expect(during.hasOpenAttr, 'nothing shows before the content').toBe(false);
        expect(during.isOpen).toBe(false);

        h.release();
        await page.waitForFunction(() => !!document.getElementById('fragC'), null, { timeout: 8000 });
        await page.waitForTimeout(150);
        const after = await readState(page, 'C');
        expect(after.isOpen).toBe(true);
        expect(after.hasOpenAttr).toBe(true);
        expect(after.isLoading).toBe(false);
        expect(after.events.open).toBe(1);
        expect(after.events.close).toBe(0);
        expect(errors).toEqual([]);
    });

    test('§09 the adopted-preload path: a close during the adopted wait drops the body when it arrives (RED pre-change)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);
        const h = await holdRoute(page, 'D');

        // hover warms (the GET is held), the click adopts the in-flight preload
        const started = page.waitForRequest((r) => r.url().endsWith('/fragD'));
        await page.hover('#trig-d');
        await started;
        await page.click('#trig-d');
        await page.waitForFunction(() => {
            var p = window.gina.popin.getPopinByName('D');
            var el = p && document.getElementById(p.id);
            return !!(el && el.hasAttribute('open'));
        }, null, { timeout: 8000 });
        const during = await readState(page, 'D');
        expect(during.isLoading, 'the adopted wait is a loading state too').toBe(true);
        expect(during.isOpen).toBe(false);

        await page.evaluate(() => window.gina.popin.close('D'));
        await page.waitForTimeout(150);
        const mid = await readState(page, 'D');
        expect(mid.hasOpenAttr).toBe(false);
        expect(mid.isLoading).toBe(false);
        expect(mid.events.close).toBe(1);

        h.release();
        await page.waitForTimeout(500);
        const after = await readState(page, 'D');
        expect(after.frag, 'the adopted body is dropped on arrival').toBe(false);
        expect(after.hasOpenAttr, 'the dialog did not re-open').toBe(false);
        expect(after.isOpen).toBe(false);
        expect(after.events.open).toBe(0);
        expect(after.events.close).toBe(1);
        expect(after.events.error).toBe(0);
        expect(errors).toEqual([]);
        if (process.env.GH76_S4_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });
});
