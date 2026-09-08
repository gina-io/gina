'use strict';

/**
 * Playwright RUNTIME e2e for #B459 — the hidden metadata fields the staged-upload layer
 * writes into the real form when the staging response carries a NESTED `preview` object
 * (the real built gina bundle, a real file selection, a real staging POST, a real save POST).
 *
 * The defect: `mandatoryFields` lists `preview`, and the auto-create loop ("completing by
 * adding non-declared mandatoring fields in the DOM: all but preview") has no preview
 * exclusion — so a form that declares no `[preview][...]` hidden inputs gets a FLAT
 * `<prefix>[0][preview]` input; the fill loop then assigns the response's preview OBJECT to
 * that input's `.value`, which string-coerces to "[object Object]", and the save posts it.
 *
 * Arms (each a control for the others):
 *   01 DECLARED control  -> the four declared sub-fields are filled from the response, no flat
 *                           preview input exists, the save body carries the sub-fields
 *   02 UNDECLARED scene  -> no flat `doc[0][preview]` input, and no "[object Object]" anywhere
 *                           in the DOM or on the wire (RED before the fix)
 *   03 thumbnail control -> BOTH forms render the nested preview thumbnail (guards the fix
 *                           against silencing the render for undeclared forms)
 *   99 dump              -> the full state for the record
 *
 * Subtract lever: B459_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at
 * the bundle URL (page.route, zero disk mutation); `routeHits` proves the old bytes ran.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// a 1x1 transparent PNG (69 bytes) — the staged file
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B459_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B459_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/** Every hidden input of a form whose name starts with the upload prefix `doc[0]`, as {name: value}. */
function readGenerated(page, formId) {
    return page.evaluate((formId) => {
        const form = document.getElementById(formId);
        const out = {};
        Array.prototype.forEach.call(form.querySelectorAll('input[type="hidden"]'), (el) => {
            if (el.name.indexOf('doc[0]') === 0) out[el.name] = el.value;
        });
        const previewBox = document.getElementById(formId === 'b459form' ? 'docA-preview' : 'docB-preview');
        return {
            fields: out,
            thumbnails: previewBox ? previewBox.querySelectorAll('img').length : null,
            thumbnailSrc: previewBox && previewBox.querySelector('img') ? previewBox.querySelector('img').getAttribute('src') : null,
            objectObjectInDom: form.outerHTML.indexOf('[object Object]') > -1,
            bogus: !!form.querySelector('input[name="zzz-bogus-never"]')
        };
    }, formId);
}

/** Boot, stage a file through the given input, wait for the fill, then submit the form and capture the save body. */
async function scene(page, formId, inputId, submitId) {
    const routeHits = await maybeServePrefixBundle(page);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    let stageStatus = null, saveBody = null, savePosts = 0;
    page.on('response', (r) => { if (r.url().indexOf('/upload-stage') > -1) stageStatus = r.status(); });
    page.on('request', (r) => {
        if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { savePosts++; saveBody = r.postData(); }
    });

    await page.goto(BASE + 'upload-preview');
    await page.waitForFunction(() => !!(
        window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms
        && window.gina.validator.$forms['b459form'] && window.gina.validator.$forms['b459declared']
    ), null, { timeout: 15000 });

    await page.setInputFiles('#' + inputId, { name: 'me.png', mimeType: 'image/png', buffer: PNG });
    // positive control that the staging round trip ran and the fill loop wrote: a
    // mandatory field the response carries lands in the form
    await page.waitForFunction((formId) => {
        const el = document.querySelector('#' + formId + ' input[name="doc[0][location]"]');
        return !!(el && el.value === '/tmp/uploads/staged-me.png');
    }, formId, { timeout: 10000 });
    await page.waitForTimeout(300);
    const afterStage = await readGenerated(page, formId);

    await page.click('#' + submitId);
    await expect.poll(() => savePosts, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(200);

    const s = { afterStage, saveBody, stageStatus, pageErrors, routeHits: routeHits.n };
    if (process.env.B459_PREFIX_BUNDLE) expect(s.routeHits, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    expect(afterStage.bogus, 'CONTROL FAILED: bogus selector matched (stuck true)').toBe(false);
    expect(stageStatus, 'the staging POST did not get its 200').toBe(200);
    expect(pageErrors, 'uncaught exception on the page').toEqual([]);
    expect(typeof saveBody, 'the save POST carried no body').toBe('string');
    return s;
}

test.describe('#B459 — staged-upload preview fields when the response carries a nested preview object', () => {

    test('01 DECLARED control: the four sub-fields are filled, no flat preview input, sub-fields on the wire', async ({ page }) => {
        const s = await scene(page, 'b459declared', 'docB', 'b459declared-submit');
        const f = s.afterStage.fields;
        expect(f['doc[0][preview][location]']).toBe('/tmp/uploads/staged-me-preview.png');
        expect(f['doc[0][preview][uri]']).toBe('/media/previews/staged-me-preview.png');
        expect(f['doc[0][preview][width]']).toBe('1');
        expect(f['doc[0][preview][height]']).toBe('1');
        expect(Object.prototype.hasOwnProperty.call(f, 'doc[0][preview]'), 'a flat preview input must not exist').toBe(false);
        expect(s.afterStage.objectObjectInDom).toBe(false);
        expect(s.saveBody).toContain('staged-me-preview.png');
        expect(s.saveBody).not.toContain('[object Object]');
    });

    test('02 UNDECLARED scene: no flat preview input, no "[object Object]" in the DOM or on the wire', async ({ page }) => {
        const s = await scene(page, 'b459form', 'docA', 'b459form-submit');
        const f = s.afterStage.fields;
        // the mandatory non-preview fields still land (positive control inside the defect arm)
        expect(f['doc[0][mime]']).toBe('image/png');
        expect(f['doc[0][size]']).toBe('69');
        expect(Object.prototype.hasOwnProperty.call(f, 'doc[0][preview]'), 'a flat preview input must not be auto-created').toBe(false);
        expect(s.afterStage.objectObjectInDom, '"[object Object]" in the form DOM').toBe(false);
        expect(s.saveBody, '"[object Object]" on the wire').not.toContain('[object Object]');
    });

    test('03 thumbnail control: both forms render the nested preview thumbnail', async ({ page }) => {
        const a = await scene(page, 'b459form', 'docA', 'b459form-submit');
        expect(a.afterStage.thumbnails, 'undeclared form: thumbnail count').toBe(1);
        expect(a.afterStage.thumbnailSrc).toBe('/upload-tmp/staged-me-preview.png');
        const b = await scene(page, 'b459declared', 'docB', 'b459declared-submit');
        expect(b.afterStage.thumbnails, 'declared form: thumbnail count').toBe(1);
        expect(b.afterStage.thumbnailSrc).toBe('/upload-tmp/staged-me-preview.png');
    });

    test('99 dump: full state for the record', async ({ page }) => {
        const a = await scene(page, 'b459form', 'docA', 'b459form-submit');
        // eslint-disable-next-line no-console
        console.log('B459-STATE-A ' + JSON.stringify(a));
        const b = await scene(page, 'b459declared', 'docB', 'b459declared-submit');
        // eslint-disable-next-line no-console
        console.log('B459-STATE-B ' + JSON.stringify(b));
    });
});
