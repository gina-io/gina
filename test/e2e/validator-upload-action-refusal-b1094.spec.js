'use strict';

/**
 * Playwright RUNTIME e2e for #B1094: a staged file input with no staging action refuses a
 * selection before any request.
 *
 * The /upload fixture's `#doc` input has no `data-gina-form-upload-action`, and the harness serves no
 * `upload-to-tmp-xml` route, so the bind leaves the attribute absent. Before the fix a drop on the
 * input's zone posted the staging to `/null` (a 404, reported as a failed staging). Now the change
 * listener refuses the selection: no request, the `uploadNotSent` message in the input's error slot
 * and the form's live region, the declared on-error callback with `{ refused: true, reason: 'action',
 * … }`, the input emptied once the change dispatch is over, the zone back to `idle`. The drop path
 * needs a real engine: jsdom implements no `DataTransfer` (see validator-upload-dropzone.spec.js).
 *
 * INSTRUMENT DISCIPLINE. §02 is the control: the same page and the same drop, with an action set on
 * the input before the drop, must stage the file and run no refusal. Without it §01 would also pass
 * for a page whose drops never reached the change listener.
 *
 * Red-first seam: B1094_BUNDLE=<path to a gina.min.js> serves that bundle instead of the built one.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-action-refusal-b1094.spec.js
 */

const fs = require('fs');
const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/upload';

test.beforeEach(async ({ page }) => {
    if (process.env.B1094_BUNDLE) {
        const body = fs.readFileSync(process.env.B1094_BUNDLE, 'utf8');
        await page.route('**/js/gina.min.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: body }));
    }
    await page.goto(BASE);
    // the dropzone stamp is the bind signal (see validator-upload-dropzone.spec.js)
    await page.waitForFunction(() => !!document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone'), null, { timeout: 15000 });
});

/**
 * Gives the fixture's input an error slot and an on-error callback, optionally a staging action, and
 * records what a capture listener of its `change` reads.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|null} action - a staging action to set on the input, or null for none
 * @returns {Promise<void>}
 */
async function instrument(page, action) {
    await page.evaluate((a) => {
        const el = document.getElementById('doc');
        const slot = document.createElement('p');
        slot.id = 'doc-error';
        el.form.appendChild(slot);
        el.setAttribute('data-gina-form-upload-on-error', 'onDocRefused');
        if (a) { el.setAttribute('data-gina-form-upload-action', a); }
        window.__refusals = [];
        window.onDocRefused = function (event, data) {
            window.__refusals.push({ type: event.type, target: event.target && event.target.id, bubbles: event.bubbles, data: JSON.parse(JSON.stringify(data)) });
        };
        window.__atChange = [];
        el.addEventListener('change', (e) => { window.__atChange.push(e.target.files.length ? e.target.files[0].name : null); }, true);
    }, action);
}

/**
 * Drops one text file on the fixture's zone, through a real DataTransfer.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function drop(page) {
    await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['hello dropped world'], 'dropped.txt', { type: 'text/plain' }));
        const zone = document.getElementById('drop-zone');
        ['dragenter', 'dragover', 'drop'].forEach((t) => zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })));
    });
}

/**
 * The page's state after a drop.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<object>} the input's file count and pending selection, the zone's state, the
 *  slot's text, the live region's text, the callback's calls and what the `change` read
 */
function stateOf(page) {
    return page.evaluate(() => {
        const el = document.getElementById('doc');
        const slot = document.getElementById('doc-error');
        return {
            files    : el.files.length,
            pending  : el.pendingFiles || null,
            zone     : document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone-state'),
            slot     : slot ? slot.textContent : null,
            region   : Array.from(document.querySelectorAll('#uploader [aria-live="polite"]')).map((r) => r.textContent).join('|'),
            refusals : window.__refusals,
            atChange : window.__atChange
        };
    });
}

test.describe('#B1094 a staged input with no staging action (real bundle, real DataTransfer)', () => {

    test('01 - a dropped file is refused before any request', async ({ page }) => {
        const posts = [];
        page.on('request', (r) => { if (r.method() === 'POST') { posts.push(new URL(r.url()).pathname); } });
        await instrument(page, null);
        await drop(page);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        // emptied once the change dispatch is over
        await expect.poll(async () => (await stateOf(page)).files).toBe(0);
        await expect.poll(async () => (await stateOf(page)).region).toContain('dropped.txt was not uploaded');
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts, 'no staging request leaves').toEqual([]);
        expect(s.refusals[0]).toEqual({
            type: 'error.hform', target: 'doc', bubbles: false,
            data: { refused: true, reason: 'action', files: ['dropped.txt'], error: 'dropped.txt was not uploaded', transportError: false }
        });
        expect(s.slot).toBe('dropped.txt was not uploaded');
        expect(s.zone).toBe('idle');
        expect(s.pending, 'the refused file never counts as held').toBeNull();
        expect(s.atChange, 'a listener of the same change still reads the dropped file').toEqual(['dropped.txt']);
    });

    test('02 - CONTROL: with an action, the same drop is staged and nothing is refused', async ({ page }) => {
        const posts = [];
        await page.route('**/b1094-stage', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: [{ name: 'staged-dropped.txt', group: 'untagged', originalFilename: 'dropped.txt', ext: 'txt', encoding: '7bit', size: 19, location: '/tmp/staged-dropped.txt', mime: 'text/plain', tmpUri: '/upload-tmp/staged-dropped.txt' }] })
        }));
        page.on('request', (r) => { if (r.method() === 'POST') { posts.push(new URL(r.url()).pathname); } });
        await instrument(page, '/b1094-stage');
        await drop(page);
        await expect.poll(() => posts.length).toBe(1);
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts).toEqual(['/b1094-stage']);
        expect(s.refusals).toEqual([]);
        expect(s.slot).toBe('');
    });
});
