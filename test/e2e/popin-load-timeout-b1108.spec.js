'use strict';

/**
 * Playwright RUNTIME e2e for #B1108 — the opt-in popin load limit (`loadTimeout`).
 *
 * A popin whose content request never answered kept its loading shell, and its trigger
 * busy, with no limit. `loadTimeout` (milliseconds; per popin with
 * `new Popin({ loadTimeout })`, for every popin without its own value with
 * `gina.setOptions({ popin: { loadTimeout } })`; absent = no limit, the default; a
 * per-popin `0` = no limit for that popin) aborts such a load at its limit and fails it
 * through the existing failure path: `error` fires with
 * `{ status: 408, error: 'Request Timeout' }`, then the shell closes unless a listener
 * loaded content. The hover/focus warm of the URL carries the same limit, so a click that
 * adopted a stalled warm falls back to one click-time load of its own: at worst twice the
 * limit.
 *
 * Harness: the real built bundle from runtime-server.js, the page `page.route`'d, every
 * content request HELD by its route (never answered unless the arm releases it) — the
 * scene of popin-loading-state.spec.js.
 *
 * Red-first: on the pre-#B1108 bundle, 01, 02, 04, 05, 07, 08 and 09 fail (no `error`
 * ever fires; the shell or the busy trigger stays). 03, 06, 10 and 11 pass on both
 * sides: 06 and 10 show that the default is unchanged, 03 and 11 that a close and an
 * answer in time keep their precedence over the limit.
 *
 * Run (a dedicated port, so reuseExistingServer can never pick up another tree's server):
 *   GINA_E2E_PORT=3291 npx playwright test test/e2e/popin-load-timeout-b1108.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;
const LIMIT = 1000;
const TIMEOUT_PAYLOAD = { status: 408, error: 'Request Timeout' };

// The route-served page has no server-rendered boot call: run the loader's
// onGinaLoaded once the bundle is in (popin-loading-state.spec.js's kicker).
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// Every trigger opts out of the hover/focus warm except D, the adopted-warm arm's.
function trigger(name, src, warm) {
    return '<button id="trig-' + name.toLowerCase() + '" data-gina-dialog="' + name + '" data-gina-dialog-src="' + src + '"'
        + ( warm ? '' : ' data-gina-dialog-preload="false"' ) + '>Open ' + name + '</button>';
}

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>load limit</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>load limit</h1>'
    + trigger('B', '/fragB') + trigger('D', '/fragD', true) + trigger('N', '/fragN') + trigger('C', '/fragC')
    + trigger('G', '/fragG') + trigger('L', '/fragL') + trigger('Z', '/fragZ') + trigger('E', '/fragE')
    + trigger('X', '/fragX') + trigger('A', '/fragA') + trigger('P', '/fragP')
    + '</body></html>';

/** Records, page-side, when each trigger was clicked (capture phase: before the plugin's own handler). */
const CLICK_CLOCK = '(function(){window.__clickAt={};document.addEventListener(\'click\',function(e){'
    + 'var t=e.target&&e.target.closest?e.target.closest(\'[data-gina-dialog]\'):null;'
    + 'if(t){window.__clickAt[t.getAttribute(\'data-gina-dialog\')]=performance.now();}},true);}());';

async function gotoScene(page) {
    await page.addInitScript(CLICK_CLOCK);
    await page.route('**/load-limit', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto(BASE + '/load-limit');
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null, { timeout: 15000 }
    );
    // The recorder: counts and stamps open / close / error per popin, and keeps every error payload.
    await page.evaluate(() => {
        window.__rec = {};
        window.__watch = function (n) {
            var p = window.gina.popin.getPopinByName(n);
            var r = window.__rec[n] = { open: 0, close: 0, error: 0, errors: [], openAt: null, closeAt: null, errorAt: null };
            ['open', 'close', 'error'].forEach(function (k) {
                document.addEventListener(k + '.' + p.id, function (e) {
                    r[k]++;
                    r[k + 'At'] = performance.now();
                    if (k === 'error') {
                        var d;
                        try { d = JSON.parse(JSON.stringify(e.detail)); } catch (x) { d = String(e.detail); }
                        r.errors.push(d);
                    }
                }, true);
            });
        };
    });
}

/** Constructs the popins, in order, each with its options; then watches each one. */
async function registerPopins(page, defs) {
    const reg = await page.evaluate((list) => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var chain = Promise.resolve();
            list.forEach(function (d) {
                chain = chain.then(function () {
                    return new Promise(function (r) {
                        new Popin(Object.assign({ name: d.name }, d.opts)).on('ready', function () { r(); });
                    });
                });
            });
            chain.then(function () {
                list.forEach(function (d) { window.__watch(d.name); });
                resolve('READY');
            });
        });
    }), defs);
    expect(reg, 'the popins must register').toBe('READY');
}

/** Holds `/frag<name>`: the request stays pending until `release(status, body)`, if ever. */
async function holdRoute(page, name) {
    let release;
    const held = new Promise((r) => { release = r; });
    const seen = { n: 0 };
    await page.route('**/frag' + name, async (route) => {
        seen.n++;
        const answer = await held;
        try {
            await route.fulfill({ status: answer.status, contentType: 'text/html; charset=utf-8', body: answer.body });
        } catch (e) { /* the page aborted the request first */ }
    });
    return { release: (status, body) => release({ status: status, body: body || '<p>boom</p>' }), seen };
}

function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        var trig = document.querySelector('[data-gina-dialog="' + n + '"]');
        var rec = (window.__rec && window.__rec[n]) || null;
        var clickAt = window.__clickAt[n];
        return {
            isLoading: !!(p && p.isLoading === true),
            isOpen: !!(p && p.isOpen === true),
            hasOpenAttr: !!(el && el.hasAttribute('open')),
            skeleton: !!(el && el.querySelector('.gina-popin-skeleton')),
            html: el ? el.innerHTML : null,
            triggerBusy: !!(trig && (trig.disabled || trig.getAttribute('aria-disabled') === 'true'
                || trig.getAttribute('data-gina-loading') === 'true')),
            rec: rec,
            errorAfterClick: ( rec && rec.errorAt !== null && typeof(clickAt) == 'number' ) ? Math.round(rec.errorAt - clickAt) : null
        };
    }, name);
}

function waitShell(page, name) {
    return page.waitForFunction((n) => {
        var p = window.gina.popin.getPopinByName(n);
        var el = p && document.getElementById(p.id);
        return !!(el && el.hasAttribute('open'));
    }, name, { timeout: 8000 });
}

function waitError(page, name, timeout) {
    return page.waitForFunction((n) => !!(window.__rec[n] && window.__rec[n].error >= 1), name, { timeout: timeout });
}

function setProjectLimit(page, ms) {
    return page.evaluate((v) => { window.gina.setOptions({ popin: { loadTimeout: v } }); }, ms);
}

async function clickHeld(page, name) {
    const h = await holdRoute(page, name);
    const started = page.waitForRequest((r) => r.url().endsWith('/frag' + name));
    await page.click('#trig-' + name.toLowerCase());
    await started;
    return h;
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    return errors;
}

test.describe('#B1108 — popin loadTimeout (real bundle)', () => {
    test.setTimeout(30000);

    test('01 a per-popin limit fails a held click-time load at the limit: one 408 error, the shell closes, the trigger is released', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'B', opts: { preOpen: true, loadTimeout: LIMIT } }]);
        const h = await clickHeld(page, 'B');
        await waitShell(page, 'B');
        await waitError(page, 'B', 6000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'B');
        expect(s.rec.errors, 'one error, the timeout payload').toEqual([TIMEOUT_PAYLOAD]);
        expect(s.errorAfterClick, 'not before the limit').toBeGreaterThanOrEqual(LIMIT - 50);
        expect(s.errorAfterClick, 'at the limit').toBeLessThan(LIMIT + 2000);
        expect(s.hasOpenAttr, 'the shell closed').toBe(false);
        expect(s.skeleton).toBe(false);
        expect(s.isLoading).toBe(false);
        expect(s.isOpen).toBe(false);
        expect(s.rec.close, 'close fired once').toBe(1);
        expect(s.rec.open, 'the real open never ran').toBe(0);
        expect(s.rec.closeAt, 'error fires before the shell closes').toBeGreaterThanOrEqual(s.rec.errorAt);
        expect(s.triggerBusy, 'the trigger is released').toBe(false);
        expect(h.seen.n, 'one request').toBe(1);
        expect(pageErrors).toEqual([]);
    });

    test('02 an error listener that loads content keeps the dialog open with that content', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'E', opts: { preOpen: true, loadTimeout: LIMIT } }]);
        await page.evaluate(() => {
            var p = window.gina.popin.getPopinByName('E');
            document.addEventListener('error.' + p.id, function () {
                p.loadContent('<p id="b1108-fallback">Could not load, try again later.</p>');
            });
        });
        await clickHeld(page, 'E');
        await waitShell(page, 'E');
        await waitError(page, 'E', 6000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'E');
        expect(s.rec.errors).toEqual([TIMEOUT_PAYLOAD]);
        expect(s.isOpen, 'the listener completed the open').toBe(true);
        expect(s.hasOpenAttr).toBe(true);
        expect(s.html, 'with the listener\'s content').toContain('b1108-fallback');
        expect(s.rec.open, 'open fired once').toBe(1);
        expect(s.rec.close, 'the dialog was not closed').toBe(0);
        expect(pageErrors).toEqual([]);
    });

    test('03 a close before the limit stays final: no error once the limit has passed', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'X', opts: { preOpen: true, loadTimeout: LIMIT } }]);
        const h = await clickHeld(page, 'X');
        await waitShell(page, 'X');
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.gina.popin.getPopinByName('X').close(); });
        await page.waitForTimeout(LIMIT + 1000);
        const s = await readState(page, 'X');
        expect(s.rec.error, 'no error for a cancel, before or after the limit').toBe(0);
        expect(s.rec.close).toBe(1);
        expect(s.rec.open).toBe(0);
        expect(s.hasOpenAttr).toBe(false);
        expect(s.isLoading).toBe(false);
        expect(s.triggerBusy).toBe(false);
        expect(h.seen.n).toBe(1);
        expect(pageErrors).toEqual([]);
    });

    test('04 a click adopting a stalled hover warm fails within twice the limit: one 408 error, the shell closes', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'D', opts: { preOpen: true, loadTimeout: LIMIT } }]);
        const h = await holdRoute(page, 'D');
        const warm = page.waitForRequest((r) => r.url().endsWith('/fragD'));
        await page.hover('#trig-d');
        await warm;
        await page.click('#trig-d');
        await waitShell(page, 'D');
        await waitError(page, 'D', 8000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'D');
        expect(s.rec.errors, 'one error, the timeout payload').toEqual([TIMEOUT_PAYLOAD]);
        expect(s.errorAfterClick, 'within twice the limit').toBeLessThan(2 * LIMIT + 1500);
        expect(s.hasOpenAttr, 'the shell closed').toBe(false);
        expect(s.isLoading).toBe(false);
        expect(s.rec.close).toBe(1);
        expect(s.rec.open).toBe(0);
        expect(s.triggerBusy, 'the trigger is released').toBe(false);
        expect(h.seen.n, 'the warm, then the click-time fallback').toBeGreaterThanOrEqual(2);
        // a re-warm of the URL after the close fails at its own limit, silently
        await page.waitForTimeout(LIMIT + 700);
        const after = await readState(page, 'D');
        expect(after.rec.error, 'still one error').toBe(1);
        expect(after.hasOpenAttr).toBe(false);
        expect(pageErrors).toEqual([]);
    });

    test('05 a popin without preOpen: one 408 error at the limit, the trigger is released', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'N', opts: { loadTimeout: LIMIT } }]);
        const h = await clickHeld(page, 'N');
        await waitError(page, 'N', 6000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'N');
        expect(s.rec.errors).toEqual([TIMEOUT_PAYLOAD]);
        expect(s.errorAfterClick).toBeGreaterThanOrEqual(LIMIT - 50);
        expect(s.triggerBusy, 'the trigger is released').toBe(false);
        expect(s.hasOpenAttr, 'nothing was ever shown').toBe(false);
        expect(s.rec.open).toBe(0);
        expect(s.rec.close).toBe(0);
        expect(h.seen.n).toBe(1);
        expect(pageErrors).toEqual([]);
    });

    test('06 CONTROL — no loadTimeout anywhere: a held load still shows its shell past the limit, no error', async ({ page }) => {
        await gotoScene(page);
        await registerPopins(page, [{ name: 'C', opts: { preOpen: true } }]);
        await clickHeld(page, 'C');
        await waitShell(page, 'C');
        await page.waitForTimeout(2 * LIMIT + 500);
        const s = await readState(page, 'C');
        expect(s.rec.error).toBe(0);
        expect(s.hasOpenAttr, 'the shell is still showing').toBe(true);
        expect(s.isLoading).toBe(true);
        expect(s.triggerBusy).toBe(true);
    });

    test('07 gina.setOptions({ popin: { loadTimeout } }) applies to a popin without its own value', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await registerPopins(page, [{ name: 'P', opts: { preOpen: true } }]);
        await setProjectLimit(page, LIMIT);
        await clickHeld(page, 'P');
        await waitShell(page, 'P');
        await waitError(page, 'P', 6000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'P');
        expect(s.rec.errors).toEqual([TIMEOUT_PAYLOAD]);
        expect(s.errorAfterClick).toBeGreaterThanOrEqual(LIMIT - 50);
        expect(s.hasOpenAttr).toBe(false);
        expect(s.rec.close).toBe(1);
        expect(pageErrors).toEqual([]);
    });

    test('08 the project limit applies to a declarative popin no code constructed', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        await gotoScene(page);
        await setProjectLimit(page, LIMIT);
        const h = await clickHeld(page, 'G');
        // the click registered the popin: watch it now, long before its limit
        await page.evaluate(() => { window.__watch('G'); });
        await waitError(page, 'G', 6000);
        await page.waitForTimeout(200);
        const s = await readState(page, 'G');
        expect(s.rec.errors).toEqual([TIMEOUT_PAYLOAD]);
        expect(s.triggerBusy, 'the trigger is released').toBe(false);
        expect(h.seen.n).toBe(1);
        expect(pageErrors).toEqual([]);
    });

    test('09 a per-popin value wins over the project limit', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        const own = 2500;
        await gotoScene(page);
        await registerPopins(page, [{ name: 'L', opts: { preOpen: true, loadTimeout: own } }]);
        await setProjectLimit(page, LIMIT);
        await clickHeld(page, 'L');
        await waitShell(page, 'L');
        await page.waitForTimeout(LIMIT + 600);
        const mid = await readState(page, 'L');
        expect(mid.rec.error, 'no error at the project limit').toBe(0);
        expect(mid.isLoading).toBe(true);
        await waitError(page, 'L', 6000);
        const s = await readState(page, 'L');
        expect(s.rec.errors).toEqual([TIMEOUT_PAYLOAD]);
        expect(s.errorAfterClick, 'at its own limit').toBeGreaterThanOrEqual(own - 50);
        expect(pageErrors).toEqual([]);
    });

    test('10 a per-popin 0 means no limit for that popin, whatever the project limit', async ({ page }) => {
        await gotoScene(page);
        await registerPopins(page, [{ name: 'Z', opts: { preOpen: true, loadTimeout: 0 } }]);
        await setProjectLimit(page, LIMIT);
        await clickHeld(page, 'Z');
        await waitShell(page, 'Z');
        await page.waitForTimeout(2 * LIMIT + 500);
        const s = await readState(page, 'Z');
        expect(s.rec.error).toBe(0);
        expect(s.hasOpenAttr, 'the shell is still showing').toBe(true);
        expect(s.isLoading).toBe(true);
    });

    test('11 an answer before the limit opens normally and no error follows once the limit has passed', async ({ page }) => {
        const pageErrors = collectPageErrors(page);
        const own = 1500;
        await gotoScene(page);
        await registerPopins(page, [{ name: 'A', opts: { preOpen: true, loadTimeout: own } }]);
        const h = await clickHeld(page, 'A');
        await waitShell(page, 'A');
        await page.waitForTimeout(300);
        h.release(200, '<p id="b1108-real">The real content.</p>');
        await page.waitForFunction(() => window.__rec.A.open >= 1, null, { timeout: 6000 });
        await page.waitForTimeout(own + 500);
        const s = await readState(page, 'A');
        expect(s.rec.error).toBe(0);
        expect(s.rec.open).toBe(1);
        expect(s.rec.close).toBe(0);
        expect(s.isOpen).toBe(true);
        expect(s.html).toContain('b1108-real');
        expect(pageErrors).toEqual([]);
    });
});
