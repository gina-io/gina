'use strict';

/**
 * gh#83 parts 1 & 2 — #B724 (the status-0 message) and #B725 (a file input's fakepath).
 * Drives the real built bundle; red-first against the pre-fix dist (measured 2026-10-01 on
 * the published 0.7.1 dist: the old literal rendered and ignored the override; the fakepath
 * rode the save body), green after the rebuild.
 *
 *   #B724 — a status-0 XHR settle must render an honest, project-overridable message, not the
 *           hardcoded "Transport failure: the request did not reach the server".
 *   #B725 — a staged file input's `.value` (C:\fakepath\<name>) must not ride the XHR payload.
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// a staged input whose prefix does NOT collide with its name, served from the harness origin,
// so a leaked fakepath would ride the save body under the input's own name as a scalar.
const DISTINCT_PREFIX_HTML = `<!DOCTYPE html><html><head>
<script src="/js/gina.onload.b459.js"></script>
<script src="/js/gina.min.js"></script>
<script>(function(){var t=0;function k(){try{if(window.gina&&window.gina.config&&typeof window.onGinaLoaded==='function'&&!window.gina.isFrameworkLoaded){window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)&&t++<100){setTimeout(k,50);}}k();}());</script>
</head><body>
<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">
<input id="titleA" type="text" name="title" value="undeclared">
<input id="docA" type="file" name="doc"
  data-gina-form-upload-action="/upload-stage"
  data-gina-form-upload-prefix="staged"
  data-gina-form-upload-preview="docA-preview"
  data-gina-form-upload-error="docA-error">
<ul id="docA-preview"></ul><p id="docA-error" hidden></p>
<button id="b459form-submit" type="submit">Save</button>
</form></body></html>`;

async function bootPreview(page) {
    await page.goto(BASE + 'upload-preview');
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
}

test.describe('gh#83 part 1 — #B724 the status-0 message is honest and overridable', () => {

    test('01 the default text says "did not complete", never "did not reach the server"', async ({ page }) => {
        await page.route('**/upload-stage', (route) => route.abort('connectionrefused'));
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        await bootPreview(page);
        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForFunction(() => {
            const el = document.getElementById('docA-error');
            return !!(el && el.textContent && el.textContent.trim().length);
        }, null, { timeout: 10000 });
        const text = (await page.locator('#docA-error').textContent()).trim();
        expect(text).toContain('did not complete');
        expect(text).not.toContain('did not reach the server');
        expect(pageErrors).toEqual([]);
    });

    test('02 a gina.config.a11y.transportError override reaches the rendered text', async ({ page }) => {
        await page.route('**/upload-stage', (route) => route.abort('connectionrefused'));
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        await bootPreview(page);
        await page.evaluate(() => { window.gina.config.a11y = Object.assign(window.gina.config.a11y || {}, { transportError: 'Le transfert a échoué' }); });
        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForFunction(() => {
            const el = document.getElementById('docA-error');
            return !!(el && el.textContent && el.textContent.indexOf('échoué') > -1);
        }, null, { timeout: 10000 });
        const text = (await page.locator('#docA-error').textContent()).trim();
        expect(text).toBe('Le transfert a échoué');
        expect(pageErrors).toEqual([]);
    });
});

test.describe('gh#83 part 2 — #B725 a file input fakepath never rides the XHR payload', () => {

    test('01 a staged input with a distinct prefix does not leak C:\\fakepath into the save body', async ({ page }) => {
        let releaseStage; const held = new Promise((r) => { releaseStage = r; });
        let saveBody = null, savePosts = 0;
        await page.route('**/upload-stage', async (route) => { await held; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[]}' }); });
        page.on('request', (r) => { if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { savePosts++; saveBody = r.postData(); } });
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

        const b64 = Buffer.from(DISTINCT_PREFIX_HTML, 'utf8').toString('base64url');
        await page.goto(BASE + 'x76-page?b64=' + b64);
        await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });

        await page.setInputFiles('#docA', { name: 'me.pdf', mimeType: 'application/pdf', buffer: PNG });
        await page.waitForTimeout(300);
        await page.click('#b459form-submit');
        await expect.poll(() => savePosts, { timeout: 8000 }).toBe(1);
        await page.waitForTimeout(150);
        releaseStage();

        expect(saveBody, 'the save body carried no fakepath').not.toContain('fakepath');
        expect(saveBody, 'the file input value is not posted as a scalar').not.toContain('"doc":"C:');
        // the other fields are unaffected
        expect(saveBody).toContain('"title":"undeclared"');
        expect(pageErrors).toEqual([]);
    });

    test('02 CONTROL a plain (non-staged) text field is still collected', async ({ page }) => {
        // guards that #B725 only skips staged file inputs, not ordinary controls
        let saveBody = null, savePosts = 0;
        await page.route('**/upload-stage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{ name: 'staged-me.png', group: 'untagged', originalFilename: 'me.png', ext: 'png', encoding: '7bit', size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-me.png', mime: 'image/png', tmpUri: '/upload-tmp/staged-me.png' }] }) }));
        page.on('request', (r) => { if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { savePosts++; saveBody = r.postData(); } });
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

        await bootPreview(page);
        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForFunction(() => { const el = document.querySelector('#b459form input[name="doc[0][location]"]'); return !!(el && el.value === '/tmp/uploads/staged-me.png'); }, null, { timeout: 10000 });
        await page.click('#b459form-submit');
        await expect.poll(() => savePosts, { timeout: 8000 }).toBe(1);

        expect(saveBody).toContain('"title":"undeclared"');       // plain text field survives
        expect(saveBody).toContain('/tmp/uploads/staged-me.png');  // the staged metadata rides
        expect(saveBody).not.toContain('fakepath');
        expect(pageErrors).toEqual([]);
    });
});
