'use strict';

/**
 * Playwright RUNTIME e2e for #B1043 — a form reset drops a submit that waits for one of the form's
 * staged uploads (#B726): the upload's settle replays nothing, and the busy state the gesture armed
 * is released at once (the real built gina bundle, the /upload-preview page, real clicks,
 * `form.reset()` and the handle's `.resetFields()`).
 *
 * The defect: a submit made while a staged upload is in flight records a wait on the form's record,
 * keeps the trigger busy, and is replayed through its own door when the upload succeeds. Only an
 * unbind cleared that wait, so after a reset the trigger stayed busy and the upload's success
 * replayed the submit: the restored values were posted, with the staged file's metadata, although
 * the reset had cleared the file input.
 *
 * The fix: `resetFields` drops the wait first, and releases the busy state unless a request of the
 * form's own is in flight (its settle owns that state), as a failed upload does.
 *
 * The staging route is held open by the test and released with a success once the reset is done.
 *
 *   01 a submit waiting, form.reset()                    -> busy released at once, nothing sent   (RED)
 *   02 the same, the handle's resetFields()                                                        (RED)
 *   03 a new submit after the reset, the upload still in flight -> it waits again, one save
 *      (RED only at « busy released at once »: before the fix the stale wait also replays once)
 *   04 CONTROL no reset: the waiting submit is replayed once, with the staged metadata
 *
 * Pre-fix arm: `GINA_B1043_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle instead
 * of the working-tree dist (the plugins subtract recipe).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PREFIX_BUNDLE = process.env.GINA_B1043_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1043_PREFIX_BUNDLE) : null;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const STAGED = JSON.stringify({ files: [{ name: 'staged-me.png', group: 'untagged', originalFilename: 'me.png', ext: 'png', encoding: '7bit', size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-me.png', mime: 'image/png', tmpUri: '/upload-tmp/staged-me.png' }] });
const OK = { status: 200, contentType: 'application/json', body: STAGED };

/**
 * Holds every staging request until the test releases it with `{ status, contentType, body }`.
 *
 * @param {object} page
 * @returns {{count: number, release: function[]}}
 */
function holdStaging(page) {
    const ctl = { count: 0, release: [] };
    page.route('**/upload-stage', async (route) => {
        ctl.count++;
        const outcome = await new Promise((resolve) => ctl.release.push(resolve));
        await route.fulfill(outcome);
    });
    return ctl;
}

/**
 * Counts the real form's saves and keeps their bodies.
 *
 * @param {object} page
 * @returns {{n: number, bodies: string[]}}
 */
function countSaves(page) {
    const saves = { n: 0, bodies: [] };
    page.on('request', (r) => { if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { saves.n++; saves.bodies.push(String(r.postData() || '')); } });
    return saves;
}

/**
 * Opens /upload-preview, serving the pre-fix bundle when one is given, and waits for the form's record.
 *
 * @param {object} page
 * @returns {Promise<{errors: string[], prefix: number}>} uncaught errors, and how many times the
 *   pre-fix bundle was served
 */
async function bootPreview(page) {
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.goto(BASE + 'upload-preview');
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/**
 * The submit control's busy mark and whether the form's record holds a waiting submit.
 *
 * @param {object} page
 * @returns {Promise<{busy: string|null, wait: boolean}>}
 */
function readWait(page) {
    return page.evaluate(() => ({
        busy: document.getElementById('b459form-submit').getAttribute('data-gina-loading'),
        wait: !!window.gina.validator.$forms.b459form.stagedUploadWait
    }));
}

/** Selects a file on the staged input, and waits for its staging request to be held. */
async function stageFile(page, staging) {
    await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect.poll(() => staging.count, { timeout: 5000 }).toBe(1);
}

/** Clicks the submit control as a person does, and lets the door record its wait. */
async function clickSubmit(page) {
    await page.click('#b459form-submit');
    await page.waitForTimeout(500);
}

/** Resets the form by `form.reset()` or by the handle's `resetFields()`, then lets the reset's pass run. */
async function reset(page, way) {
    await page.evaluate((w) => {
        if (w === 'resetFields') { window.gina.validator.$forms.b459form.resetFields(); } else { document.getElementById('b459form').reset(); }
    }, way);
    await page.waitForTimeout(300);
}

test.describe('#B1043 — a reset drops a submit waiting for a staged upload', () => {

    for (const way of ['form.reset', 'resetFields']) {
        const label = ( way === 'form.reset' ) ? '01' : '02';
        test(label + ' a submit waiting on a staged upload, then ' + way + '(): busy released at once, nothing sent after the upload succeeds', async ({ page }) => {
            const staging = holdStaging(page); const saves = countSaves(page);
            const seen = await bootPreview(page);
            await stageFile(page, staging);
            await clickSubmit(page);
            const held = await readWait(page);
            const whileHeld = saves.n;
            await reset(page, way);
            const afterReset = await readWait(page);
            staging.release[0](OK);
            await page.waitForTimeout(1500);

            expect(whileHeld === 0 && held.busy === 'true' && held.wait, 'the submit waits on the upload, or the arm proves nothing').toBe(true);
            expect(afterReset.busy, 'the reset releases the busy state at once').toBe('false');
            expect(afterReset.wait, 'and drops the waiting submit').toBe(false);
            expect(saves.n, 'the upload\'s success replays nothing').toBe(0);
            expect(seen.errors).toEqual([]);
        });
    }

    test('03 a new submit after the reset, the upload still in flight: it waits again, then one save', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page);
        const seen = await bootPreview(page);
        await stageFile(page, staging);
        await clickSubmit(page);
        await reset(page, 'form.reset');
        const afterReset = await readWait(page);
        await clickSubmit(page);
        const waitingAgain = await readWait(page);
        const whileHeld = saves.n;
        staging.release[0](OK);
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(1200);

        expect(afterReset.busy, 'the reset releases the busy state at once').toBe('false');
        expect(waitingAgain.wait, 'the new submit records its own wait').toBe(true);
        expect(waitingAgain.busy, 'and its gesture shows the busy state').toBe('true');
        expect(whileHeld, 'nothing is sent while the upload is in flight').toBe(0);
        expect(saves.n, 'the upload\'s success sends the new submit, once').toBe(1);
        expect(await page.evaluate(() => document.getElementById('b459form-submit').getAttribute('data-gina-loading')), 'released once the save settles').toBe('false');
        expect(seen.errors).toEqual([]);
    });

    test('04 CONTROL no reset: the waiting submit is replayed once, with the staged metadata', async ({ page }) => {
        const staging = holdStaging(page); const saves = countSaves(page);
        const seen = await bootPreview(page);
        await stageFile(page, staging);
        await clickSubmit(page);
        const held = await readWait(page);
        const whileHeld = saves.n;
        staging.release[0](OK);
        await expect.poll(() => saves.n, { timeout: 5000 }).toBe(1);
        await page.waitForTimeout(800);

        expect(whileHeld).toBe(0);
        expect(held.busy).toBe('true');
        expect(held.wait).toBe(true);
        expect(saves.n, 'exactly one save').toBe(1);
        expect(saves.bodies[0], 'the save carries the staged metadata').toContain('"location":"/tmp/uploads/staged-me.png"');
        expect(seen.errors).toEqual([]);
    });
});
