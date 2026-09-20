'use strict';

/**
 * Playwright RUNTIME e2e for #B574 — a `preOpen: true` popin opened through the NEW
 * declarative trigger (`data-gina-dialog` + `-src`) with the DEFAULT (modeless) modal
 * resolution never reached `isOpen = true`.
 *
 * THE DEFECT. `showLoadingShell` is always born modal (`$el.showModal()`), which sets the
 * dialog's `open` attribute to the EMPTY STRING. `popinOpen`'s re-entry guard read
 * `!$el.getAttribute('open')` — `!""` is `true` — so the guard never skipped a shell-opened
 * dialog. On the modal path a second `showModal()` is tolerated by the engine; on the
 * modeless path (`resolveModal()` rule 5, the new API's default) `$el.show()` throws
 * `InvalidStateError: … already open as a modal dialog`, and `popinOpen` aborted before
 * `isOpen = true` and `setActivePopinId`. Content had already been applied, so the user saw
 * an open popin the framework believed was closed: `close()` returned early, `getActivePopin()`
 * ignored it, and a form inside it was routed as "not in a popin". Fix: `hasAttribute('open')`.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The failure is the engine's own `HTMLDialogElement.show()`
 * refusing a dialog that is already open as modal — jsdom implements neither `show()` nor
 * `showModal()`, so only a real engine can throw it.
 *
 * Harness: the committed runtime server serves the REAL built bundle; the scene page and its
 * fragments are `page.route`'d (zero fixture footprint), the same shape the gh#76 harness
 * measured this defect with.
 *
 * Red-first: §01 FAILS on the pre-#B574 dist (`isOpen` false + an `InvalidStateError` page
 * error, measured). §02 (legacy trigger, modal path) and §03 (new trigger forced modal — the
 * workaround the gh#76 harness needed) pass on BOTH sides of the fix: they are the controls
 * that prove the arm is reading the modeless path, not preOpen in general.
 *
 * Run:
 *   npx playwright test test/e2e/popin-preopen-modeless.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

// The boot kicker: the served gina.onload.js defines window.onGinaLoaded; the framework
// calls it itself on a normal page, but a routed page has no server-rendered whisper, so
// poll until the config is there and kick the boot by hand (the gh#76 harness idiom).
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>preopen</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>preopen</h1>'
    // §01 — NEW declarative trigger, no modal attribute ⇒ resolveModal() rule 5 ⇒ modeless.
    + '<button id="trig-b" data-gina-dialog="B" data-gina-dialog-src="/fragB" data-gina-dialog-preload="false">Open B</button>'
    // §02 — LEGACY trigger ⇒ modal path (a second showModal() is tolerated).
    + '<button data-gina-popin-name="L" data-gina-popin-url="/fragL">Open L</button>'
    // §03 — NEW trigger forced modal ⇒ modal path (the workaround).
    + '<button id="trig-m" data-gina-dialog="M" data-gina-dialog-src="/fragM" data-gina-dialog-preload="false" data-gina-dialog-modal="true">Open M</button>'
    + '</body></html>';

function frag(name) {
    return '<div id="frag' + name + '"><p>' + name + ' content</p></div>';
}

async function gotoScene(page) {
    await page.route('**/preopen-modeless', (r) => r.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8', body: PAGE
    }));
    for (const name of ['B', 'L', 'M']) {
        await page.route('**/frag' + name, (r) => r.fulfill({
            status: 200, contentType: 'text/html; charset=utf-8', body: frag(name)
        }));
    }
    await page.goto(BASE + '/preopen-modeless');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
}

/** Register the three popins, every one `preOpen: true` — the shape under test. */
async function registerPreOpenPopins(page) {
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var mk = function (n) {
                return new Promise(function (r) {
                    new Popin({ name: n, preOpen: true }).on('ready', function () { r(n); });
                });
            };
            mk('B').then(function () { return mk('L'); }).then(function () { return mk('M'); })
                .then(function () { resolve('READY'); });
        });
    }));
    expect(reg, 'the three preOpen popins must register').toBe('READY');
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

/** Open `name` by clicking `selector`, wait for its fragment to land, then read the registry. */
async function openAndRead(page, selector, name) {
    await page.click(selector);
    await page.waitForFunction((n) => !!document.getElementById('frag' + n), name, { timeout: 8000 });
    // Give popinOpen its turn (it runs synchronously after the body is applied; one
    // frame is plenty and keeps the read from racing the throw).
    await page.waitForTimeout(150);
    return await page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        return {
            found: !!p,
            isOpen: !!(p && p.isOpen),
            hasOpenAttr: !!(el && el.hasAttribute('open')),
            isActive: !!(p && window.gina.popin.activePopinId === p.id)
        };
    }, name);
}

test.describe('#B574 — preOpen + new declarative trigger + default modeless resolution', () => {

    test('§01 the popin reaches isOpen=true and no InvalidStateError is thrown (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await gotoScene(page);
        await registerPreOpenPopins(page);

        const state = await openAndRead(page, '#trig-b', 'B');

        expect(state.found, 'popin B must be registered').toBe(true);
        // The shell was born modal, so the attribute is there on both sides of the fix —
        // it is the FRAMEWORK's view that diverged from it.
        expect(state.hasOpenAttr, 'the dialog carries the open attribute').toBe(true);
        expect(errors.filter((m) => /InvalidStateError|already open/.test(m)),
            'popinOpen must not throw on a shell-opened dialog').toEqual([]);
        expect(state.isOpen, 'the framework must consider B open').toBe(true);
        expect(state.isActive, 'B must be the active popin once open').toBe(true);
    });

    test('§02 CONTROL — a legacy trigger (modal path) opens a preOpen popin on both sides of the fix', async ({ page }) => {
        const errors = collectPageErrors(page);
        await gotoScene(page);
        await registerPreOpenPopins(page);

        const state = await openAndRead(page, '[data-gina-popin-name="L"]', 'L');

        expect(errors, 'no page error on the legacy path').toEqual([]);
        expect(state.isOpen, 'L is open').toBe(true);
        expect(state.hasOpenAttr).toBe(true);
    });

    test('§03 CONTROL — a new trigger forced modal opens a preOpen popin on both sides of the fix', async ({ page }) => {
        const errors = collectPageErrors(page);
        await gotoScene(page);
        await registerPreOpenPopins(page);

        const state = await openAndRead(page, '#trig-m', 'M');

        expect(errors, 'no page error on the forced-modal path').toEqual([]);
        expect(state.isOpen, 'M is open').toBe(true);
        expect(state.hasOpenAttr).toBe(true);
    });
});
