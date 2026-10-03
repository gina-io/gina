'use strict';

/**
 * #B728 — the `reason` a status-0 staging failure carries after a back-forward-cache restore.
 *
 * #B724 tags a status-0 XHR settle `reason: 'unload'` while the page is being torn down (the
 * browser aborts in-flight requests on navigation) and `reason: 'transport'` otherwise. The flag
 * behind it is set on `pagehide`. A page restored from the back-forward cache keeps its JS state,
 * so without a reset on `pageshow` every later status-0 settle would still read `unload`.
 *
 * Drives the real built bundle. Red-first against the pre-fix dist (measured 2026-10-01: arm 03
 * reported `unload`), green after the rebuild. The transitions are dispatched as synthetic
 * PageTransitionEvents — the listeners are registered on `window` in the capture phase, so a
 * synthetic dispatch reaches them exactly as the browser's own event would.
 *
 *   01 CONTROL no page transition            -> reason 'transport'
 *   02 pagehide only (the page is unloading)  -> reason 'unload'    (#B724's intent, preserved)
 *   03 pagehide then pageshow (bfcache)       -> reason 'transport' (#B728)
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The on-error callback must exist before the first staging send (the validator captures it
// then), and the error slot must exist or the error path never reaches the callback.
const PAGE_HTML = `<!DOCTYPE html><html><head>
<script>window.__reasons = []; window.onB728Error = function (e, result) { window.__reasons.push(result && result.reason); };</script>
<script src="/js/gina.onload.b459.js"></script>
<script src="/js/gina.min.js"></script>
<script>(function(){var t=0;function k(){try{if(window.gina&&window.gina.config&&typeof window.onGinaLoaded==='function'&&!window.gina.isFrameworkLoaded){window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)&&t++<100){setTimeout(k,50);}}k();}());</script>
</head><body>
<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">
<input id="titleA" type="text" name="title" value="t">
<input id="docA" type="file" name="doc"
  data-gina-form-upload-action="/upload-stage"
  data-gina-form-upload-on-error="onB728Error"
  data-gina-form-upload-preview="docA-preview"
  data-gina-form-upload-error="docA-error">
<ul id="docA-preview"></ul><p id="docA-error" hidden></p>
<button id="b459form-submit" type="submit">Save</button>
</form></body></html>`;

async function boot(page) {
    await page.route('**/upload-stage', (route) => route.abort('connectionrefused'));
    const b64 = Buffer.from(PAGE_HTML, 'utf8').toString('base64url');
    await page.goto(BASE + 'x76-page?b64=' + b64);
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
}

/** Stage a file whose request the route aborts, and return the `reason` its error carried. */
async function failedStageReason(page, name) {
    const before = await page.evaluate(() => window.__reasons.length);
    await page.setInputFiles('#docA', { name: name, mimeType: 'image/png', buffer: PNG });
    await expect.poll(() => page.evaluate(() => window.__reasons.length), { timeout: 5000 }).toBe(before + 1);
    return page.evaluate(() => window.__reasons[window.__reasons.length - 1]);
}

test.describe('#B728 — a status-0 staging failure is tagged unload only while the page unloads', () => {

    test('01 CONTROL with no page transition the reason is "transport"', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        await boot(page);
        expect(await failedStageReason(page, 'one.png')).toBe('transport');
        expect(pageErrors).toEqual([]);
    });

    test('02 after a pagehide (the page is unloading) the reason is "unload"', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        await boot(page);
        await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
        expect(await failedStageReason(page, 'two.png')).toBe('unload');
        expect(pageErrors).toEqual([]);
    });

    test('03 after pagehide then pageshow (a back-forward-cache restore) the reason is "transport" again', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        await boot(page);
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        expect(await failedStageReason(page, 'three.png')).toBe('transport');
        expect(pageErrors).toEqual([]);
    });
});
