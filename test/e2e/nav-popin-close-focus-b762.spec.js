'use strict';

/**
 * #B762 — after a client navigation that closes an open popin, focus is on the swapped region,
 * as the client-navigation guide promises for every swap, and the scroll position is the one the
 * navigation chose.
 *
 * gina/nav closes the active popin from its swap (nav/main.js `applyFragment`). The close returns
 * focus to the popin's trigger, so it must run BEFORE the swap moves focus to the region and
 * applies its scroll decision; run after them, it takes focus back to the trigger and scrolls the
 * page to it. The triggers here sit below a tall spacer, so a focus return that scrolls is
 * visible in `scrollY`.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64= with a `data-gina-nav` region at the top; the harness serves nav's routing table
 * only to pages under /nav, so this spec answers /_gina/assets/routing.json itself with one
 * negotiable route and answers its fragment request with `Vary: X-Gina-Navigate`. The navigation
 * is `gina.nav.navigate()`, the same pipeline as an intercepted click. Every navigation is
 * checked to be a fragment swap (the region shows the fragment, the document was not reloaded).
 *
 *   01 CONTROL no popin open: focus on the region, scrolled to the top
 *   02 a modal popin (legacy trigger) open: closed, focus on the region, scrolled to the top
 *   03 a non-modal popin (data-gina-dialog) open: the same
 *
 * Run:
 *   npx playwright test test/e2e/nav-popin-close-focus-b762.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// One negotiable route. `bundle` must equal the b459 whisper's page.environment.bundle ('e2e').
const ROUTING = { 'b762-next': { bundle: 'e2e', method: 'get', url: '/b762/next', param: {}, negotiate: true } };

// the region at the top, the two triggers below a tall spacer, both outside the region
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>nav popin focus</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script>window.__pageInstance = String(Math.random()).slice(2);</script>'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>'
    + '<main data-gina-nav><div id="frag-home"><h2 id="frag-title">HOME</h2></div></main>'
    + '<div style="height: 3000px">spacer</div>'
    + '<button id="open-legacy" data-gina-popin-name="lg" data-gina-popin-url="/frag/lg.html" data-gina-dialog-preload="false">Open legacy</button>'
    + ' <a id="open-dialog" href="/frag/dlg.html" data-gina-dialog="dlg" data-gina-dialog-src="/frag/dlg.html" data-gina-dialog-preload="false">Open dialog</a>'
    + '</body></html>';

const FRAGS = {
    lg:  '<div id="lg-frag"><p>legacy popin</p><button class="gina-popin-close" type="button">Close</button></div>',
    dlg: '<div id="dlg-frag"><p>dialog popin</p><button class="gina-popin-close" type="button">Close</button></div>'
};

// the region the navigation swaps in
const NEXT = '<div id="frag-next" data-gina-nav-title="Next"><h2 id="frag-title">NEXT</h2></div>';

/** Wire the routes, load the page, wait for the popin and nav handlers. */
async function boot(pw) {
    const sink = { errors: [], navFragment: 0, navFull: 0 };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    await pw.route('**/_gina/assets/routing.json', (route) => route.fulfill({
        status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(ROUTING) }));
    await pw.route('**/b762/next', (route) => {
        if (/fragment/i.test(route.request().headers()['x-gina-navigate'] || '')) {
            sink.navFragment++;
            return route.fulfill({ status: 200, body: NEXT, headers: {
                'Content-Type': 'text/html; charset=utf-8', 'Vary': 'X-Gina-Navigate', 'Cache-Control': 'no-store' } });
        }
        sink.navFull++;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            body: '<!DOCTYPE html><html><head><title>full page</title></head><body><p>full page</p></body></html>' });
    });
    await pw.route('**/frag/*.html', (route) => {
        const key = /\/frag\/(\w+)\.html/.exec(route.request().url())[1];
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAGS[key] });
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(PAGE, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.hasPopinHandler === true && window.gina.hasNavHandler === true), null, { timeout: 15000 });
    return sink;
}

/** Register popin `lg` (a legacy trigger needs a constructed popin; no validator). */
async function registerLegacy(pw) {
    const reg = await pw.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'lg' }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'popin lg must register').toBe('READY');
}

/** Click a trigger and wait until popin `name` is open. */
async function openPopin(pw, selector, name) {
    await pw.click(selector);
    await pw.waitForFunction((n) => {
        const p = window.gina.popin.getPopinByName(n);
        return !!(p && p.isOpen);
    }, name, { timeout: 8000 });
    await pw.waitForTimeout(400);
}

/** Navigate through gina/nav; returns the swap checks and what focus and scroll ended on. */
async function navigate(pw, sink, popinName) {
    const before = await pw.evaluate(() => window.__pageInstance);
    await pw.evaluate(() => { window.gina.nav.navigate('/b762/next'); });
    const swapped = await pw.waitForFunction(() => {
        const t = document.getElementById('frag-title');
        return !!(t && t.textContent.trim() === 'NEXT');
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    await pw.waitForTimeout(400);
    return pw.evaluate(([b, swappedIn, n, frag, full]) => {
        const region = document.querySelector('[data-gina-nav]');
        const p = n ? window.gina.popin.getPopinByName(n) : null;
        return {
            swapped: swappedIn, sameDocument: !!b && b === window.__pageInstance, fragmentRequests: frag, fullPageRequests: full,
            popinOpen: p ? !!p.isOpen : null,
            focusOnRegion: document.activeElement === region,
            scrollY: Math.round(window.scrollY)
        };
    }, [before, swapped, popinName || null, sink.navFragment, sink.navFull]);
}

const AFTER = { swapped: true, sameDocument: true, fragmentRequests: 1, fullPageRequests: 0, focusOnRegion: true, scrollY: 0 };

test.describe('#B762 — focus and scroll after a navigation that closes a popin', () => {

    test('01 CONTROL no popin open: focus on the region, scrolled to the top', async ({ page: pw }) => {
        const sink = await boot(pw);
        await pw.evaluate(() => window.scrollTo(0, 2000));
        expect(await navigate(pw, sink, null)).toEqual(Object.assign({ popinOpen: null }, AFTER));
        expect(sink.errors).toEqual([]);
    });

    test('02 a modal popin (legacy trigger) open: closed, focus on the region, scrolled to the top', async ({ page: pw }) => {
        const sink = await boot(pw);
        await registerLegacy(pw);
        // not `#open-legacy`: registering the popin rewrites a legacy trigger's authored id to
        // `popin.click.<popin id>`, so the trigger is selected by its popin name
        await openPopin(pw, '[data-gina-popin-name="lg"]', 'lg');
        expect(await pw.evaluate(() => window.scrollY > 1000), 'scene premise: the page is scrolled down to the trigger').toBe(true);
        expect(await navigate(pw, sink, 'lg')).toEqual(Object.assign({ popinOpen: false }, AFTER));
        expect(sink.errors).toEqual([]);
    });

    test('03 a non-modal popin (data-gina-dialog) open: closed, focus on the region, scrolled to the top', async ({ page: pw }) => {
        const sink = await boot(pw);
        await openPopin(pw, '#open-dialog', 'dlg');
        expect(await pw.evaluate(() => window.scrollY > 1000), 'scene premise: the page is scrolled down to the trigger').toBe(true);
        expect(await navigate(pw, sink, 'dlg')).toEqual(Object.assign({ popinOpen: false }, AFTER));
        expect(sink.errors).toEqual([]);
    });
});
