'use strict';

/**
 * Playwright RUNTIME e2e for #B579 — reloading an OPEN declarative popin no longer blanks it.
 *
 * `gina.popin.load(name, url)` on a popin that is already open lands through
 * `popinLoadContent(result, isRedirecting = true)`: that call writes the new body into the
 * dialog, then — its legacy redirect emit — fires `loaded.<id>` with the POPIN OBJECT as the
 * event detail, which the legacy trigger's listener only binds and opens on. The declarative
 * trigger (`data-gina-dialog`) wires a DIFFERENT `loaded.<id>` listener, one that APPLIES the
 * detail through `handleLoadedBody` → `applyContent`, and `applyContent` writes `''` for a
 * non-string. Net effect, measured on the published bundle: the new body lands and is wiped
 * a moment later — the dialog is left EMPTY, with no error anywhere.
 *
 * Fix: the declarative listener applies nothing for a non-string detail (the body that
 * event announces was already written by the call that fired it).
 *
 * Arms:
 *   §01 declarative popin, opened, then load()-ed again: the second body is in the dialog (RED pre-fix: empty)
 *   §02 the same with `preOpen: true` (RED pre-fix: empty)
 *   §03 CONTROL — a LEGACY trigger reloaded the same way keeps working on both sides
 *       (its listener never applied the detail, which is why the defect stayed invisible there)
 *
 * Subtract lever: B579_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the
 * bundle URL (page.route, zero disk mutation); `routeHits` is the evidence it executed.
 *
 * Run:
 *   npx playwright test test/e2e/popin-reload-open.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>reload open</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>reload open</h1>'
    + '<button id="trig-b" data-gina-dialog="B" data-gina-dialog-src="/fragB" data-gina-dialog-preload="false">Open B</button>'
    + '<button id="trig-p" data-gina-dialog="P" data-gina-dialog-src="/fragP" data-gina-dialog-preload="false">Open P</button>'
    + '<button data-gina-popin-name="L" data-gina-popin-url="/fragL">Open L</button>'
    + '</body></html>';

function frag(name, gen) {
    return '<div id="frag' + name + gen + '"><p>' + name + ' content ' + gen + '</p></div>';
}

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B579_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B579_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

async function gotoScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    await page.route('**/reload-open', (r) => r.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8', body: PAGE
    }));
    for (const name of ['B', 'P', 'L']) {
        // the first generation at /frag<name>, the second at /frag<name>2
        await page.route('**/frag' + name, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: frag(name, '') }));
        await page.route('**/frag' + name + '2', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: frag(name, '2') }));
    }
    await page.goto(BASE + '/reload-open');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
    return routeHits;
}

async function registerPopins(page) {
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var mk = function (n, opts) {
                return new Promise(function (r) {
                    new Popin(Object.assign({ name: n }, opts)).on('ready', function () { r(n); });
                });
            };
            mk('B', {}).then(function () { return mk('P', { preOpen: true }); }).then(function () { return mk('L', {}); })
                .then(function () { resolve('READY'); });
        });
    }));
    expect(reg, 'the three popins must register').toBe('READY');
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        return {
            isOpen: !!(p && p.isOpen === true),
            hasOpenAttr: !!(el && el.hasAttribute('open')),
            first: !!document.getElementById('frag' + n),
            second: !!document.getElementById('frag' + n + '2'),
            empty: !!(el && el.innerHTML.trim() === '')
        };
    }, name);
}

/** Open through `selector`, wait for the first body, reload with the second URL, wait a beat, read. */
async function openThenReload(page, selector, name) {
    await page.click(selector);
    await page.waitForFunction((n) => !!document.getElementById('frag' + n), name, { timeout: 8000 });
    await page.waitForTimeout(150);
    const opened = await readState(page, name);
    await page.evaluate((n) => window.gina.popin.load(n, '/frag' + n + '2'), name);
    await page.waitForTimeout(600);
    const reloaded = await readState(page, name);
    return { opened, reloaded };
}

test.describe('#B579 — reloading an open popin (real bundle)', () => {

    test('§01 a declarative popin reloaded while open shows the second body (RED pre-fix: the dialog is blanked)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);

        const r = await openThenReload(page, '#trig-b', 'B');
        expect(r.opened.isOpen, 'open after the first load').toBe(true);
        expect(r.opened.first).toBe(true);
        expect(r.reloaded.isOpen, 'still open').toBe(true);
        expect(r.reloaded.hasOpenAttr).toBe(true);
        expect(r.reloaded.empty, 'the dialog must not be blanked').toBe(false);
        expect(r.reloaded.second, 'the second body is in the dialog').toBe(true);
        expect(r.reloaded.first, 'the first body is replaced').toBe(false);
        expect(errors).toEqual([]);
        if (process.env.B579_PREFIX_BUNDLE) expect(hits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    });

    test('§02 the same reload on a preOpen popin (RED pre-fix: blanked)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);

        const r = await openThenReload(page, '#trig-p', 'P');
        expect(r.opened.isOpen).toBe(true);
        expect(r.reloaded.empty, 'the dialog must not be blanked').toBe(false);
        expect(r.reloaded.second, 'the second body is in the dialog').toBe(true);
        expect(r.reloaded.isOpen).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B579_PREFIX_BUNDLE) expect(hits.n).toBeGreaterThan(0);
    });

    test('§03 CONTROL — a legacy trigger reloaded while open keeps working on both sides of the fix', async ({ page }) => {
        const errors = collectPageErrors(page);
        const hits = await gotoScene(page);
        await registerPopins(page);

        const r = await openThenReload(page, '[data-gina-popin-name="L"]', 'L');
        expect(r.opened.isOpen).toBe(true);
        expect(r.reloaded.second, 'the second body is in the dialog').toBe(true);
        expect(r.reloaded.empty).toBe(false);
        expect(r.reloaded.isOpen).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.B579_PREFIX_BUNDLE) expect(hits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    });
});
