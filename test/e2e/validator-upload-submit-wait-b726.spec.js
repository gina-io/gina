'use strict';

/**
 * #B726 (gh#83 part 3) — a submit made while one of its form's staged uploads is still in flight
 * WAITS for it, then sends exactly once with the now-filled hidden metadata. Before the fix the
 * submit went out at once and posted the upload's hidden fields EMPTY.
 *
 * Drives the real built bundle. Red-first against the pre-fix dist (measured 2026-10-01: every
 * waiting arm posted during the held upload; the controls passed), green after the rebuild.
 * The staging route is held open by the test and released with the outcome each arm needs.
 *
 *   01 click while held: nothing sent, busy, announced; success -> one save, filled metadata
 *   02 the upload fails during the wait -> nothing sent, busy released, the server message shown
 *   03 a second click while waiting -> still exactly one save
 *   04 $forms[id].submit()  05 requestSubmit()  06 a click inside the button
 *   07 an <a data-gina-form-submit> trigger  -> each waits, then one save
 *   08 two staged inputs in flight -> waits for BOTH
 *   09 the form leaves the page during the wait -> nothing sent
 *   10 a form inside a popin -> waits, then one save
 *   11 gina.config.a11y.uploadPending reaches the live region
 *   12 CONTROL no upload in flight -> sent at once
 *   13 CONTROL the upload already finished -> sent at once, filled
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const STAGED = (location) => JSON.stringify({ files: [{ name: 'staged-me.png', group: 'untagged', originalFilename: 'me.png', ext: 'png', encoding: '7bit', size: 69, width: 1, height: 1, location: location, mime: 'image/png', tmpUri: '/upload-tmp/staged-me.png' }] });
const OK = (location) => ({ status: 200, contentType: 'application/json', body: STAGED(location || '/tmp/uploads/staged-me.png') });

const HEAD = `<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>
<script>(function(){var t=0;function k(){try{if(window.gina&&window.gina.config&&typeof window.onGinaLoaded==='function'&&!window.gina.isFrameworkLoaded){window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)&&t++<100){setTimeout(k,50);}}k();}());</script>`;

/** Holds every staging request until the test releases it with `{ status, contentType, body }`. */
function holdStaging(page) {
    const ctl = { count: 0, release: [] };
    page.route('**/upload-stage', async (route) => {
        ctl.count++;
        const outcome = await new Promise((resolve) => ctl.release.push(resolve));
        await route.fulfill(outcome);
    });
    return ctl;
}

function countSaves(page) {
    const saves = { n: 0, bodies: [] };
    page.on('request', (r) => { if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { saves.n++; saves.bodies.push(r.postData()); } });
    return saves;
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    return errors;
}

async function waitForForm(page) {
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
}

async function bootPreview(page) {
    await page.goto(BASE + 'upload-preview');
    await waitForForm(page);
}

async function bootHtml(page, body) {
    const html = `<!DOCTYPE html><html><head>${HEAD}</head><body>${body}</body></html>`;
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await waitForForm(page);
}

const stageFile = (page, selector) => page.setInputFiles(selector || '#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
const loadingOf = (page) => page.evaluate(() => document.getElementById('b459form-submit').getAttribute('data-gina-loading'));
const liveText = (page) => page.evaluate(() => { const r = document.getElementById('gina-aria-live-b459form'); return r ? r.textContent : null; });

/** Starts a staged upload, holds it, runs `submit`, and returns the saves sent while it was held. */
async function submitWhileHeld(page, staging, saves, submit) {
    await stageFile(page);
    await expect.poll(() => staging.count, { timeout: 5000 }).toBe(1);
    await submit();
    await page.waitForTimeout(500);
    return saves.n;
}

test.describe('#B726 — a submit waits for its form\'s staged uploads', () => {

    test('01 click while held: nothing sent, busy and announced; after success exactly one save with the filled metadata', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.click('#b459form-submit'));
        const busyWhileHeld = await loadingOf(page);
        const announced = await liveText(page);
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld, 'no save while the upload is in flight').toBe(0);
        expect(busyWhileHeld, 'the trigger shows the busy state while waiting').toBe('true');
        expect(announced).toContain('Waiting for the upload to finish');
        expect(saves.n, 'exactly one save').toBe(1);
        expect(saves.bodies[0], 'the save carries the staged metadata').toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(await loadingOf(page), 'the busy state is released once the save settles').toBe('false');
        expect(errors).toEqual([]);
    });

    test('02 the upload fails during the wait: nothing sent, busy released, the server message shown', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.click('#b459form-submit'));
        staging.release[0]({ status: 500, contentType: 'application/json', body: JSON.stringify({ status: 500, error: 'staging refused (b726)' }) });
        await page.waitForFunction(() => { const el = document.getElementById('docA-error'); return !!(el && el.textContent.indexOf('staging refused (b726)') > -1); }, null, { timeout: 5000 });
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(saves.n, 'a failed upload cancels the waiting submit').toBe(0);
        expect(await loadingOf(page), 'the busy state is released').toBe('false');
        expect(errors).toEqual([]);
    });

    test('03 a second click while waiting still yields exactly one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        await stageFile(page);
        await expect.poll(() => staging.count, { timeout: 5000 }).toBe(1);
        await page.click('#b459form-submit');
        await page.waitForTimeout(450);
        await page.click('#b459form-submit');
        await page.waitForTimeout(450);
        const whileHeld = saves.n;
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(1200);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(errors).toEqual([]);
    });

    test('04 a programmatic $forms[id].submit() waits, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.evaluate(() => window.gina.validator.$forms['b459form'].submit()));
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });

    test('05 requestSubmit() waits, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.evaluate(() => document.getElementById('b459form').requestSubmit()));
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });

    test('06 a click on markup inside the submit button waits, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        await page.evaluate(() => { document.getElementById('b459form-submit').innerHTML = '<span id="b726-label">Save A</span>'; });
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.click('#b726-label'));
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });

    test('07 an <a data-gina-form-submit> trigger waits, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootHtml(page, `<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">
<input id="titleA" type="text" name="title" value="t">
<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage" data-gina-form-upload-preview="docA-preview" data-gina-form-upload-error="docA-error">
<ul id="docA-preview"></ul><p id="docA-error" hidden></p>
<a id="b459form-submit" href="#" data-gina-form-submit="true">Save</a></form>`);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.click('#b459form-submit'));
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });

    test('08 with two staged inputs in flight the submit waits for both, then one save carrying both', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootHtml(page, `<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">
<input id="titleA" type="text" name="title" value="t">
<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage" data-gina-form-upload-preview="docA-preview" data-gina-form-upload-error="docA-error">
<ul id="docA-preview"></ul><p id="docA-error" hidden></p>
<input id="attA" type="file" name="att" data-gina-form-upload-action="/upload-stage" data-gina-form-upload-preview="attA-preview" data-gina-form-upload-error="attA-error">
<ul id="attA-preview"></ul><p id="attA-error" hidden></p>
<button id="b459form-submit" type="submit">Save</button></form>`);
        await stageFile(page, '#docA');
        await stageFile(page, '#attA');
        await expect.poll(() => staging.count, { timeout: 5000 }).toBe(2);
        await page.click('#b459form-submit');
        await page.waitForTimeout(400);
        staging.release[0](OK('/tmp/uploads/first.png'));
        await page.waitForTimeout(600);
        const afterFirst = saves.n;
        staging.release[1](OK('/tmp/uploads/second.png'));
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(afterFirst, 'still waiting while the second upload is in flight').toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('/tmp/uploads/first.png');
        expect(saves.bodies[0]).toContain('/tmp/uploads/second.png');
        expect(errors).toEqual([]);
    });

    test('09 when the form leaves the page during the wait, nothing is sent', async ({ page }) => {
        // The upload settling on a detached form throws inside onUpload (#B730/#B731, pre-existing and
        // independent of this fix), so this arm asserts the save count only, not the page errors.
        const staging = holdStaging(page); const saves = countSaves(page);
        await bootPreview(page);
        const whileHeld = await submitWhileHeld(page, staging, saves, () => page.click('#b459form-submit'));
        await page.evaluate(() => document.getElementById('b459form').remove());
        staging.release[0](OK());
        await page.waitForTimeout(1200);

        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(0);
    });

    test('10 a form inside a popin waits, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        await page.evaluate(() => {
            const a = document.createElement('a');
            a.id = 'b726-popin-trigger'; a.setAttribute('data-gina-dialog', 'b726'); a.setAttribute('data-gina-dialog-src', '/frag/ajax.html'); a.setAttribute('href', '#'); a.textContent = 'open';
            document.body.appendChild(a);
        });
        await page.click('#b726-popin-trigger');
        await expect(page.locator('dialog').filter({ hasText: 'AJAX loaded' })).toBeVisible();
        const popinId = await page.evaluate(() => window.gina.popin.getActivePopin().id);
        await page.evaluate((id) => { document.getElementById(id).appendChild(document.getElementById('b459form')); }, popinId);
        await stageFile(page);
        await expect.poll(() => staging.count, { timeout: 5000 }).toBe(1);
        // in-page click, observed: the form moved into the dialog sits where the dialog box takes
        // the driver's pointer hit-test (the forms guide's automated-testing option (a))
        const delivered = await page.evaluate(() => {
            const el = document.getElementById('b459form-submit');
            let seen = false; const spy = () => { seen = true; };
            el.addEventListener('click', spy, true); el.click(); el.removeEventListener('click', spy, true);
            return seen;
        });
        await page.waitForTimeout(500);
        const whileHeld = saves.n;
        staging.release[0](OK());
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(delivered, 'the click was delivered').toBe(true);
        expect(whileHeld).toBe(0);
        expect(saves.n).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });

    test('11 the announcement honours gina.config.a11y.uploadPending', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page);
        await bootPreview(page);
        await page.evaluate(() => { window.gina.config.a11y = Object.assign(window.gina.config.a11y || {}, { uploadPending: 'Envoi du fichier en attente' }); });
        await submitWhileHeld(page, staging, saves, () => page.click('#b459form-submit'));
        const announced = await liveText(page);
        staging.release[0](OK());

        expect(announced).toContain('Envoi du fichier en attente');
    });

    test('12 CONTROL with no upload in flight the submit is sent at once', async ({ page }) => {
        const saves = countSaves(page); const errors = collectPageErrors(page);
        await bootPreview(page);
        await page.click('#b459form-submit');
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        expect(errors).toEqual([]);
    });

    test('13 CONTROL after the upload finished the submit is sent at once with the filled metadata', async ({ page }) => {
        const saves = countSaves(page); const errors = collectPageErrors(page);
        await page.route('**/upload-stage', (route) => route.fulfill(OK()));
        await bootPreview(page);
        await stageFile(page);
        await page.waitForFunction(() => { const el = document.querySelector('#b459form input[name="doc[0][location]"]'); return !!(el && el.value === '/tmp/uploads/staged-me.png'); }, null, { timeout: 5000 });
        await page.click('#b459form-submit');
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        expect(saves.bodies[0]).toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(errors).toEqual([]);
    });
});
