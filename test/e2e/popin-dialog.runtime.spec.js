'use strict';

/**
 * Playwright RUNTIME e2e for the modernized gina dialog ("popin") system.
 *
 * Where popin-dialog.a11y.spec.js drives a framework-free fixture (it validates the
 * native-<dialog> + CSS a11y contract without booting gina), THIS spec boots the
 * REAL built gina bundle so the full-runtime delegated `data-gina-dialog*` handlers
 * run for real — closing the gap that pins + jsdom replicas cannot catch (a wiring
 * bug between two correct-in-isolation functions). It is the executing counterpart to
 * the framework-free popin-dialog.a11y.spec.js.
 *
 * The harness (test/e2e/runtime-server.js + fixtures/popin-dialog.runtime.html) is
 * started by playwright.config.js `webServer`: a tiny Node server that serves the
 * dist gina.min.js, the whisper-substituted onload, a stub /_gina/assets/routing.json,
 * and the in-memory AJAX fragments. The boot phantom (core.js) constructs the popin
 * handler at page load, so triggers injected into the live DOM are handled by the real
 * delegated `bindDelegatedOpen` + `installPreload` listeners.
 *
 * Run:
 *   npm i -D @playwright/test && npx playwright install chromium
 *   npx playwright test test/e2e/popin-dialog.runtime.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

/**
 * Navigate to the harness and wait for the boot phantom to construct the popin
 * handler (the declarative API is inert until then).
 */
async function gotoAndBoot(page) {
    await page.goto(BASE);
    await page.waitForFunction(
        () => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true),
        null,
        { timeout: 15000 }
    );
}

// #B54 — register a legacy popin: inject the trigger FIRST (bindOpen scans the DOM at
// registration), then construct + .on('ready') to fire init -> registerPopin -> bindOpen.
// bindOpen renames the trigger id, so callers select it by [data-gina-popin-name].
async function registerLegacyPopin(page, name, url, preOpen) {
    await page.evaluate(function (a) {
        var b = document.createElement('button');
        b.id = 'legacy-' + a.name;
        b.setAttribute('data-gina-popin-name', a.name);
        b.setAttribute('data-gina-popin-url', a.url);
        b.textContent = 'Open ' + a.name;
        document.body.appendChild(b);
    }, { name: name, url: url });
    return await page.evaluate(function (a) {
        return new Promise(function (resolve) {
            setTimeout(function () { resolve('TIMEOUT'); }, 6000);
            if (typeof window.require !== 'function') { resolve('NO_REQUIRE'); return; }
            window.require(['gina/popin'], function (Popin) {
                new Popin({ 'name': a.name, 'preOpen': a.preOpen }).on('ready', function () { resolve('READY'); });
            });
        });
    }, { name: name, preOpen: preOpen });
}

test.beforeEach(async ({ page }) => {
    await gotoAndBoot(page);
});

test.describe('data-gina-dialog runtime (real bundle)', () => {

    test('AJAX (data-gina-dialog-src) opens a dialog with the loaded fragment', async ({ page }) => {
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'ajax-trigger';
            a.setAttribute('data-gina-dialog', '');
            a.setAttribute('data-gina-dialog-src', '/frag/ajax.html');
            a.setAttribute('href', '#');
            a.textContent = 'Open AJAX';
            document.body.appendChild(a);
        });

        await page.click('#ajax-trigger');

        const dialog = page.locator('dialog').filter({ hasText: 'AJAX loaded' });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('#ajax-frag-title')).toHaveText('AJAX loaded');
        // The new dialog API opens non-modal by default.
        expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(false);
    });

    test('hover preload fires exactly one request; the click opens from cache (no second request)', async ({ page }) => {
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'preload-trigger';
            a.setAttribute('data-gina-dialog', '');
            a.setAttribute('data-gina-dialog-src', '/frag/preload.html');
            a.setAttribute('href', '#');
            a.textContent = 'Open preload';
            document.body.appendChild(a);
        });

        let requests = 0;
        page.on('request', (req) => {
            if (req.url().endsWith('/frag/preload.html')) { requests++; }
        });

        // Hover -> installPreload issues one GET; wait for it to land (so the cache is
        // ready — a click before completion would fall through to a second GET).
        const preloaded = page.waitForResponse((r) => r.url().endsWith('/frag/preload.html'));
        await page.hover('#preload-trigger');
        await preloaded;
        await page.waitForTimeout(150);
        expect(requests).toBe(1);

        // Click -> consumePreload serves the cached body; no second network request.
        await page.click('#preload-trigger');
        await expect(page.locator('dialog').filter({ hasText: 'Preloaded body' })).toBeVisible();
        expect(requests).toBe(1);
    });

    test('legacy: a mixed (new marker + legacy-url) trigger opens AND warns exactly once', async ({ page }) => {
        const warnings = [];
        page.on('console', (msg) => {
            if (msg.type() === 'warning') { warnings.push(msg.text()); }
        });

        // Mixed: a new `data-gina-dialog` marker + the legacy `data-gina-popin-url`.
        // The gate routes it through the new path, which aliases the legacy url
        // (src === null) and emits exactly one deprecation warning while still loading.
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'mixed-trigger';
            a.setAttribute('data-gina-dialog', '');
            a.setAttribute('data-gina-popin-url', '/frag/legacy.html');
            a.setAttribute('href', '#');
            a.textContent = 'Open legacy';
            document.body.appendChild(a);
        });
        await page.click('#mixed-trigger');
        await expect(page.locator('dialog').filter({ hasText: 'Legacy body' })).toBeVisible();

        const deprecations = warnings.filter((w) => /`data-gina-popin-url` is deprecated/.test(w));
        expect(deprecations).toHaveLength(1);
        expect(deprecations[0]).toContain('use `data-gina-dialog-src` instead');
        expect(deprecations[0]).toContain('mapped onto the new dialog path');
    });

    test('legacy: a pure-legacy (data-gina-popin-name only) trigger emits no deprecation warning', async ({ page }) => {
        const warnings = [];
        page.on('console', (msg) => {
            if (msg.type() === 'warning') { warnings.push(msg.text()); }
        });

        // Pure-legacy: `data-gina-popin-name` only (neither new attr). The gate defers
        // to bindOpen's per-element path, so resolveTrigger is never reached and no
        // deprecation warning is emitted. (Runs on its own fresh page so no dialog from
        // a sibling assertion intercepts the click.)
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'pure-trigger';
            a.setAttribute('data-gina-popin-name', 'purelegacy');
            a.setAttribute('href', '#');
            a.textContent = 'Pure legacy';
            document.body.appendChild(a);
        });
        await page.click('#pure-trigger');
        await page.waitForTimeout(300);

        expect(warnings.filter((w) => /is deprecated/.test(w))).toHaveLength(0);
    });

    test('partial replace (data-gina-dialog-target) swaps only the slot, preserving chrome', async ({ page }) => {
        // Two triggers sharing data-gina-dialog="sp" resolve to the SAME dialog
        // (getPopinByName dedup). Trigger 1 (no target) full-loads chrome + slot;
        // trigger 2 (target="#slot") re-loads and swaps ONLY the slot. (Before the
        // popinLoad partialTarget guard, an open re-load went through popinLoadContent
        // and the swap never applied — the regression this test pins.)
        await page.evaluate(() => {
            const mk = (id, src, target) => {
                const a = document.createElement('a');
                a.id = id;
                a.setAttribute('data-gina-dialog', 'sp');
                a.setAttribute('data-gina-dialog-src', src);
                if (target) { a.setAttribute('data-gina-dialog-target', target); }
                a.setAttribute('href', '#');
                a.textContent = id;
                document.body.appendChild(a);
            };
            mk('p-full', '/frag/partial-1.html', null);
            mk('p-slot', '/frag/partial-2.html', '#slot');
        });

        // First click: full load seeds the chrome + slot.
        await page.click('#p-full');
        const dialog = page.locator('dialog').filter({ hasText: 'Chrome stays' });
        await expect(dialog.locator('#partial-chrome')).toHaveText('Chrome stays');
        await expect(dialog.locator('#slot')).toHaveText('SLOT-ONE');
        // Tag the chrome node so the swap's node-identity preservation is observable.
        await dialog.locator('#partial-chrome').evaluate((el) => el.setAttribute('data-kept', 'yes'));

        // Second click: partial re-load. The trigger sits under the open dialog, so
        // dispatch the click directly (the delegated document handler still fires) —
        // this exercises the handler's routing, not click actionability.
        await page.dispatchEvent('#p-slot', 'click');

        // Only #slot changed; the chrome text AND node identity are preserved. A full
        // replace would instead show 'REPLACED chrome' and drop the data-kept marker.
        await expect(dialog.locator('#slot')).toHaveText('SLOT-TWO');
        await expect(dialog.locator('#partial-chrome')).toHaveText('Chrome stays');
        await expect(dialog.locator('#partial-chrome')).toHaveAttribute('data-kept', 'yes');
    });

    test('#B580 a MALFORMED data-gina-dialog-target falls back to a full replace instead of throwing', async ({ page }) => {
        // Three triggers on ONE dialog (data-gina-dialog="b580" dedups them), clicked in an
        // order that makes every outcome discriminating:
        //   1. no target        -> full load seeds 'Chrome stays' + SLOT-ONE;
        //   2. target="#slot"   -> CONTROL: the partial swap still runs (SLOT-TWO with the
        //      chrome text AND its data-kept marker preserved) — green on both trees, so a
        //      later full replace cannot be mistaken for the partial path breaking wholesale;
        //   3. target="#slot >" -> the fix: the engine refuses the selector, applyContent
        //      catches it and full-replaces, so the chrome becomes 'REPLACED chrome' and the
        //      data-kept marker is dropped. Pre-#B580 the uncaught SyntaxError left the
        //      dialog untouched, so BOTH the chrome assertion and the page-error count red.
        // The harness serves envIsDev:'false', so the dev-mode notice is deliberately NOT
        // asserted here — popin.test.js §22 owns the notice, this arm owns the fallback.
        const errors = [];
        page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

        await page.evaluate(() => {
            const mk = (id, src, target) => {
                const a = document.createElement('a');
                a.id = id;
                a.setAttribute('data-gina-dialog', 'b580');
                a.setAttribute('data-gina-dialog-src', src);
                if (target) { a.setAttribute('data-gina-dialog-target', target); }
                a.setAttribute('href', '#');
                a.textContent = id;
                document.body.appendChild(a);
            };
            mk('b580-full', '/frag/partial-1.html', null);
            mk('b580-ok',   '/frag/partial-2.html', '#slot');
            mk('b580-bad',  '/frag/partial-2.html', '#slot >');
        });

        await page.click('#b580-full');
        const dialog = page.locator('dialog').filter({ hasText: 'Chrome stays' });
        await expect(dialog.locator('#slot')).toHaveText('SLOT-ONE');
        // Tag the chrome node so a full replace is observable as node loss, not just text.
        await dialog.locator('#partial-chrome').evaluate((el) => el.setAttribute('data-kept', 'yes'));

        // CONTROL — a VALID selector still swaps only the slot. The triggers sit under the
        // open dialog, so dispatch directly (the delegated document handler still fires).
        await page.dispatchEvent('#b580-ok', 'click');
        await expect(dialog.locator('#slot')).toHaveText('SLOT-TWO');
        await expect(dialog.locator('#partial-chrome')).toHaveText('Chrome stays');
        await expect(dialog.locator('#partial-chrome')).toHaveAttribute('data-kept', 'yes');

        // THE FIX — the malformed selector takes the documented full-replace fallback.
        await page.dispatchEvent('#b580-bad', 'click');
        const replaced = page.locator('dialog').filter({ hasText: 'REPLACED chrome' });
        await expect(replaced.locator('#partial-chrome')).toHaveText('REPLACED chrome');
        await expect(replaced.locator('#partial-chrome')).not.toHaveAttribute('data-kept', 'yes');

        // Nothing escaped. MEASURED on HEAD's bundle, the click raises an uncaught
        // "Failed to execute 'querySelector' on 'Element': '#slot >' is not a valid
        // selector." — the count goes 0 -> 1 there, so the absence asserted here is real.
        await page.waitForTimeout(300);
        expect(errors).toEqual([]);
    });

    // --- #B54: one click = one GET (no hover/focus-preload double-fetch) -----------

    test('#B54 legacy (data-gina-popin-name + -url) plain click fires exactly one GET', async ({ page }) => {
        const reg = await registerLegacyPopin(page, 'b54legacy', '/frag/legacy.html', false);
        expect(reg).toBe('READY');
        let requests = 0;
        page.on('request', (r) => { if (r.url().endsWith('/frag/legacy.html')) { requests++; } });
        // A plain click warms an in-flight preload via focusin; the legacy click must adopt
        // it, not fire a second identical GET. (bindOpen renames the id -> select by attr.)
        await page.click('[data-gina-popin-name="b54legacy"]');
        await expect(page.locator('dialog').filter({ hasText: 'Legacy body' })).toBeVisible();
        await page.waitForTimeout(300);
        expect(requests).toBe(1);
    });

    test('#B54 new-API (data-gina-dialog-src) plain click fires exactly one GET', async ({ page }) => {
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'b54-newapi';
            a.setAttribute('data-gina-dialog', '');
            a.setAttribute('data-gina-dialog-src', '/frag/ajax.html');
            a.setAttribute('href', '#');
            a.textContent = 'Open AJAX';
            document.body.appendChild(a);
        });
        let requests = 0;
        page.on('request', (r) => { if (r.url().endsWith('/frag/ajax.html')) { requests++; } });
        // No deliberate hover: focusin (part of the click) warms an in-flight preload that
        // the click adopts via consumePreload instead of firing a parallel GET.
        await page.click('#b54-newapi');
        await expect(page.locator('dialog').filter({ hasText: 'AJAX loaded' })).toBeVisible();
        await page.waitForTimeout(300);
        expect(requests).toBe(1);
    });

    test('#B54 a preOpen popin still shows its skeleton while the adopted preload is in flight', async ({ page }) => {
        // Delay the fragment so the in-flight window (skeleton up, content not yet) is observable.
        await page.route('**/frag/legacy.html', async (route) => {
            await new Promise((r) => setTimeout(r, 1500));
            await route.continue();
        });
        const reg = await registerLegacyPopin(page, 'b54skel', '/frag/legacy.html', true);
        expect(reg).toBe('READY');
        await page.click('[data-gina-popin-name="b54skel"]');
        // In-flight: dialog open with the skeleton, real content not yet present.
        await expect(page.locator('dialog .gina-popin-skeleton')).toBeVisible();
        await expect(page.locator('dialog').filter({ hasText: 'Legacy body' })).toHaveCount(0);
        // After the preload lands: real content swaps in and the skeleton is gone.
        await expect(page.locator('dialog').filter({ hasText: 'Legacy body' })).toBeVisible({ timeout: 5000 });
        await expect(page.locator('dialog .gina-popin-skeleton')).toHaveCount(0);
    });

    // --- #B80: a warmed preload of a redirect-JSON trigger must NOT inject the raw JSON ---

    test('#B80 a warmed legacy popin whose GET returns an XHR redirect tunnels to `location`, never injects the raw JSON', async ({ page }) => {
        // /redirect-frag returns application/json {isXhrRedirect,location}. Pre-#B80 the
        // hover preload cached that JSON and consumePreload injected it verbatim as the
        // popin body (raw JSON on screen). The fix declines JSON at preloadFetch so the
        // click defers to popinLoad, whose _self tunnel loads `location` (/frag/ajax.html).
        const reg = await registerLegacyPopin(page, 'b80redirect', '/redirect-frag', false);
        expect(reg).toBe('READY');

        // Warm the preload: hover issues the GET; wait for it to land so the decline-JSON
        // decision is made before the click. (bindOpen renamed the id -> select by attr.)
        const preloaded = page.waitForResponse((r) => r.url().endsWith('/redirect-frag'));
        await page.hover('[data-gina-popin-name="b80redirect"]');
        await preloaded;
        await page.waitForTimeout(150);

        // Click: the declined preload falls through to popinLoad's redirect tunnel, which
        // loads the location fragment. The popin shows the tunnel target, NOT the raw JSON.
        await page.click('[data-gina-popin-name="b80redirect"]');
        await expect(page.locator('dialog').filter({ hasText: 'AJAX loaded' })).toBeVisible();
        // The pre-#B80 regression injected the JSON body verbatim; assert it never appears.
        await expect(page.locator('dialog').filter({ hasText: 'isXhrRedirect' })).toHaveCount(0);
    });

    // --- #B91: per-trigger preload opt-out (data-gina-dialog-preload="false") --------

    test('#B91 an opted-out new-API trigger fires no hover GET; the click fires exactly one', async ({ page }) => {
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'b91-newapi';
            a.setAttribute('data-gina-dialog', '');
            a.setAttribute('data-gina-dialog-src', '/frag/ajax.html');
            a.setAttribute('data-gina-dialog-preload', 'false');
            a.setAttribute('href', '#');
            a.textContent = 'Open without preload';
            document.body.appendChild(a);
        });
        let requests = 0;
        page.on('request', (r) => { if (r.url().endsWith('/frag/ajax.html')) { requests++; } });

        // Hover: the opt-out gate must swallow the intent — no GET fires.
        await page.hover('#b91-newapi');
        await page.waitForTimeout(400);
        expect(requests).toBe(0);

        // Click: consumePreload finds nothing (undefined slot) -> the click-time load
        // fires exactly one GET and the dialog opens with the fragment. The 0 -> 1
        // transition also validates the request counter (the absence above is real).
        await page.click('#b91-newapi');
        await expect(page.locator('dialog').filter({ hasText: 'AJAX loaded' })).toBeVisible();
        await page.waitForTimeout(300);
        expect(requests).toBe(1);
    });

    test('#B91 an opted-out legacy trigger fires no hover GET; the click fires exactly one', async ({ page }) => {
        const reg = await registerLegacyPopin(page, 'b91legacy', '/frag/legacy.html', false);
        expect(reg).toBe('READY');
        // The attribute is honored on legacy triggers too (read off the intent target).
        await page.evaluate(() => {
            document.querySelector('[data-gina-popin-name="b91legacy"]')
                .setAttribute('data-gina-dialog-preload', 'false');
        });
        let requests = 0;
        page.on('request', (r) => { if (r.url().endsWith('/frag/legacy.html')) { requests++; } });

        await page.hover('[data-gina-popin-name="b91legacy"]');
        await page.waitForTimeout(400);
        expect(requests).toBe(0);

        await page.click('[data-gina-popin-name="b91legacy"]');
        await expect(page.locator('dialog').filter({ hasText: 'Legacy body' })).toBeVisible();
        await page.waitForTimeout(300);
        expect(requests).toBe(1);
    });
});
