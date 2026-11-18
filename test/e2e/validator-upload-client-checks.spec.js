'use strict';

/**
 * Playwright RUNTIME e2e for the upload client checks: a staged file input's `accept` and
 * `data-gina-form-upload-max-size` refuse a selection before any request.
 *
 * The /upload fixture's `#doc` input is a staged input with a dropzone. Each arm gives it a staging
 * action (a route of this spec), an error slot, an on-error callback and the attributes under test,
 * then drops files on its zone (a real DataTransfer) or picks them (`setInputFiles`, which ignores
 * `accept` as a user's « All files » choice does). Before the change a staged input sent every file
 * it was given; now a file whose type `accept` excludes, or whose size is over the max size, refuses
 * the whole selection: no request, one line per reason in the slot and the form's live region, the
 * callback with `{ refused: true, reason, files, error, transportError: false }`, the input emptied,
 * the zone back to `idle`, and the files the input already held left as they were.
 *
 *   01  a dropped file of a type `accept` excludes is refused before any request
 *   02  CONTROL  the same drop, with `accept` naming its extension, is staged
 *   03  a picked file of a type `accept` excludes is refused before any request
 *   04  a file over the max size is refused before any request
 *   05  CONTROL  a file at the max size is staged
 *   06  a selection refused for both reasons: two lines, `reason: 'type'`, every refused name
 *   07  a refusal leaves the file the input already holds, and its hidden fields, as they were
 *   08  a refusal while the input's earlier selection is staging lets that staging finish
 *   09  `image/*` and `.pdf` match `Photo.PNG` and `SCAN.PDF`, and refuse `notes.txt`
 *
 * INSTRUMENT DISCIPLINE. 02 and 05 are the controls: the same page and the same path stage the file
 * and run no refusal. Without them a refusal arm would also pass for a page whose selections never
 * reached the change listener, or whose staging route never answered.
 *
 * Red-first seam: UPCHECKS_BUNDLE=<path to a gina.min.js> serves that bundle instead of the built
 * one (page.route, nothing written to the tree). On a bundle without the client checks 01, 03, 04,
 * 06 and 08 fail (their selections are sent), 07 and 09 fail (the refused file is sent too), and
 * 02 and 05 pass.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-client-checks.spec.js
 */

const fs = require('fs');
const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/upload';
const STAGE = '/uc-stage';

const TYPE_LINE = (names) => names + ' was not uploaded: this type of file is not accepted';
const SIZE_LINE = (names) => names + ' was not uploaded: the file is too large';

test.beforeEach(async ({ page }) => {
    if (process.env.UPCHECKS_BUNDLE) {
        const body = fs.readFileSync(process.env.UPCHECKS_BUNDLE, 'utf8');
        await page.route('**/js/gina.min.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: body }));
    }
    await page.goto(BASE);
    // the dropzone stamp is the bind signal (see validator-upload-dropzone.spec.js)
    await page.waitForFunction(() => !!document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone'), null, { timeout: 15000 });
});

/**
 * Answers the staging route from a plan, in request order, and records each request's path. The
 * handler never reads the request body (a route handler reads no multipart body on WebKit).
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{name: string, mime: string, size: number, delay?: number}>} plan - one staged file per answer
 * @returns {Promise<Array<string>>} the paths of the POST requests, filled as they leave
 */
async function stageRoute(page, plan) {
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST') { posts.push(new URL(r.url()).pathname); } });
    let n = 0;
    await page.route('**' + STAGE, async (route) => {
        const step = plan[Math.min(n++, plan.length - 1)];
        if (step.delay) { await new Promise((resolve) => setTimeout(resolve, step.delay)); }
        const ext = step.name.split('.').pop().toLowerCase();
        await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: [{ name: 'staged-' + step.name, group: 'untagged', originalFilename: step.name, ext: ext, encoding: '7bit', size: step.size, location: '/tmp/staged-' + step.name, mime: step.mime, tmpUri: '/upload-tmp/staged-' + step.name }] })
        });
    });
    return posts;
}

/**
 * Gives the fixture's input a staging action, an error slot, an on-error callback and the given
 * attributes, and records what a capture listener of its `change` reads.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} attrs - attribute name -> value, set on the input
 * @returns {Promise<void>}
 */
async function instrument(page, attrs) {
    await page.evaluate(({ attrs, stage }) => {
        const el = document.getElementById('doc');
        const slot = document.createElement('div');
        slot.id = 'doc-error';
        el.form.appendChild(slot);
        el.setAttribute('data-gina-form-upload-action', stage);
        el.setAttribute('data-gina-form-upload-on-error', 'onDocRefused');
        Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
        window.__refusals = [];
        window.onDocRefused = function (event, data) {
            window.__refusals.push({ type: event.type, target: event.target && event.target.id, bubbles: event.bubbles, data: JSON.parse(JSON.stringify(data)) });
        };
        window.__atChange = [];
        el.addEventListener('change', (e) => { window.__atChange.push(Array.from(e.target.files).map((f) => f.name)); }, true);
    }, { attrs: attrs, stage: STAGE });
}

/**
 * Drops files on the fixture's zone, through a real DataTransfer.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{name: string, type: string, body: string}>} files
 * @returns {Promise<void>}
 */
async function drop(page, files) {
    await page.evaluate((list) => {
        const dt = new DataTransfer();
        list.forEach((f) => dt.items.add(new File([f.body], f.name, { type: f.type })));
        const zone = document.getElementById('drop-zone');
        ['dragenter', 'dragover', 'drop'].forEach((t) => zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })));
    }, files);
}

/**
 * Picks files with the input's own picker path (`setInputFiles`, which ignores `accept`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{name: string, type: string, body: string}>} files
 * @returns {Promise<void>}
 */
async function pick(page, files) {
    await page.setInputFiles('#doc', files.map((f) => ({ name: f.name, mimeType: f.type, buffer: Buffer.from(f.body) })));
}

/**
 * The page's state.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<object>} the input's files, pending and held entries, the hidden fields of `doc`,
 *  the zone's state, the slot's lines, the live region's text, the callback's calls and what the
 *  `change` read
 */
function stateOf(page) {
    return page.evaluate(() => {
        const el = document.getElementById('doc');
        const slot = document.getElementById('doc-error');
        return {
            files    : el.files.length,
            pending  : el.pendingFiles ? Array.from(el.pendingFiles).map((f) => f.name) : null,
            held     : (el.customFiles || []).map((f) => f && f.name),
            hidden   : Array.from(el.form.querySelectorAll('input[type="hidden"]')).filter((i) => /^doc\[/.test(i.name)).map((i) => i.name + '=' + i.value),
            zone     : document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone-state'),
            lines    : slot ? Array.from(slot.getElementsByTagName('p')).map((p) => p.textContent) : null,
            region   : Array.from(document.querySelectorAll('#uploader [aria-live="polite"]')).map((r) => r.textContent).join('|'),
            refusals : window.__refusals,
            atChange : window.__atChange
        };
    });
}

/**
 * One text file of 19 bytes.
 *
 * @param {string} name
 * @param {string} [type]
 * @returns {{name: string, type: string, body: string}}
 */
function file(name, type) { return { name: name, type: type || 'text/plain', body: 'hello dropped world' }; }

test.describe('upload client checks: accept and max size refuse before any request (real bundle)', () => {

    test('01 - a dropped file of a type `accept` excludes is refused before any request', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'dropped.txt', mime: 'text/plain', size: 19 }]);
        await instrument(page, { accept: '.pdf' });
        await drop(page, [file('dropped.txt')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await expect.poll(async () => (await stateOf(page)).files).toBe(0);
        await expect.poll(async () => (await stateOf(page)).region).toContain(TYPE_LINE('dropped.txt'));
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts, 'no staging request leaves').toEqual([]);
        expect(s.refusals[0]).toEqual({
            type: 'error.hform', target: 'doc', bubbles: false,
            data: { refused: true, reason: 'type', files: ['dropped.txt'], error: TYPE_LINE('dropped.txt'), transportError: false }
        });
        expect(s.lines).toEqual([TYPE_LINE('dropped.txt')]);
        expect(s.zone).toBe('idle');
        expect(s.pending, 'the refused file never counts as held').toBeNull();
        expect(s.atChange, 'a listener of the same change still reads the dropped file').toEqual([['dropped.txt']]);
    });

    test('02 - CONTROL: the same drop, with `accept` naming its extension, is staged', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'dropped.txt', mime: 'text/plain', size: 19 }]);
        await instrument(page, { accept: '.TXT, .pdf' });
        await drop(page, [file('dropped.txt')]);
        await expect.poll(() => posts.length).toBe(1);
        await expect.poll(async () => (await stateOf(page)).held).toEqual(['dropped.txt']);
        const s = await stateOf(page);
        expect(posts).toEqual([STAGE]);
        expect(s.refusals).toEqual([]);
        expect(s.lines).toEqual([]);
    });

    test('03 - a picked file of a type `accept` excludes is refused before any request', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'photo.png', mime: 'image/png', size: 19 }]);
        await instrument(page, { accept: 'application/pdf' });
        await pick(page, [file('photo.png', 'image/png')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await expect.poll(async () => (await stateOf(page)).files).toBe(0);
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts).toEqual([]);
        expect(s.refusals[0].data).toEqual({ refused: true, reason: 'type', files: ['photo.png'], error: TYPE_LINE('photo.png'), transportError: false });
        expect(s.lines).toEqual([TYPE_LINE('photo.png')]);
        expect(s.pending).toBeNull();
    });

    test('04 - a file over the max size is refused before any request', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'big.txt', mime: 'text/plain', size: 19 }]);
        await instrument(page, { 'data-gina-form-upload-max-size': '18b' });
        await pick(page, [file('big.txt')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await expect.poll(async () => (await stateOf(page)).region).toContain(SIZE_LINE('big.txt'));
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts).toEqual([]);
        expect(s.refusals[0].data).toEqual({ refused: true, reason: 'size', files: ['big.txt'], error: SIZE_LINE('big.txt'), transportError: false });
        expect(s.lines).toEqual([SIZE_LINE('big.txt')]);
        expect(s.files).toBe(0);
    });

    test('05 - CONTROL: a file at the max size is staged', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'exact.txt', mime: 'text/plain', size: 19 }]);
        await instrument(page, { 'data-gina-form-upload-max-size': '19B' });
        await pick(page, [file('exact.txt')]);
        await expect.poll(() => posts.length).toBe(1);
        await expect.poll(async () => (await stateOf(page)).held).toEqual(['exact.txt']);
        const s = await stateOf(page);
        expect(s.refusals).toEqual([]);
        expect(s.lines).toEqual([]);
    });

    test('06 - a selection refused for both reasons: two lines, reason `type`, every refused name', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'a.pdf', mime: 'application/pdf', size: 19 }]);
        await instrument(page, { multiple: '', accept: '.pdf', 'data-gina-form-upload-max-size': '10b' });
        await pick(page, [file('notes.txt'), file('big.pdf', 'application/pdf')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts).toEqual([]);
        expect(s.lines).toEqual([TYPE_LINE('notes.txt'), SIZE_LINE('big.pdf')]);
        expect(s.region).toContain(TYPE_LINE('notes.txt') + '. ' + SIZE_LINE('big.pdf'));
        expect(s.refusals[0].data).toEqual({ refused: true, reason: 'type', files: ['notes.txt', 'big.pdf'], error: TYPE_LINE('notes.txt') + '. ' + SIZE_LINE('big.pdf'), transportError: false });
        expect(s.pending).toBeNull();
    });

    test('07 - a refusal leaves the file the input already holds, and its hidden fields, as they were', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'first.pdf', mime: 'application/pdf', size: 19 }]);
        await instrument(page, { accept: '.pdf' });
        await drop(page, [file('first.pdf', 'application/pdf')]);
        await expect.poll(async () => (await stateOf(page)).held).toEqual(['first.pdf']);
        const before = await stateOf(page);
        expect(before.hidden.length, 'the staged file has its hidden fields').toBeGreaterThan(0);
        await drop(page, [file('second.txt')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await page.waitForTimeout(300);
        const after = await stateOf(page);
        expect(posts, 'the refused file sends nothing').toEqual([STAGE]);
        expect(after.lines).toEqual([TYPE_LINE('second.txt')]);
        expect(after.held, 'the held file stays').toEqual(['first.pdf']);
        expect(after.hidden, 'its hidden fields stay').toEqual(before.hidden);
    });

    test('08 - a refusal while the input\'s earlier selection is staging lets that staging finish', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'slow.pdf', mime: 'application/pdf', size: 19, delay: 1500 }]);
        await instrument(page, { accept: '.pdf' });
        await drop(page, [file('slow.pdf', 'application/pdf')]);
        await expect.poll(() => posts.length).toBe(1);
        await drop(page, [file('bad.txt')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        const during = await stateOf(page);
        expect(during.pending, 'the earlier selection is still the one staging').toEqual(['slow.pdf']);
        await expect.poll(async () => (await stateOf(page)).held, { timeout: 10000 }).toEqual(['slow.pdf']);
        const after = await stateOf(page);
        expect(posts, 'one request: the earlier selection').toEqual([STAGE]);
        expect(after.pending).toBeNull();
        expect(after.hidden.length, 'the staged file has its hidden fields').toBeGreaterThan(0);
    });

    test('09 - `image/*` and `.pdf` match `Photo.PNG` and `SCAN.PDF`, and refuse `notes.txt`', async ({ page }) => {
        const posts = await stageRoute(page, [{ name: 'Photo.PNG', mime: 'image/png', size: 19 }, { name: 'SCAN.PDF', mime: 'application/pdf', size: 19 }]);
        await instrument(page, { accept: 'image/*,.pdf' });
        await drop(page, [file('Photo.PNG', 'image/png')]);
        await expect.poll(async () => (await stateOf(page)).held).toEqual(['Photo.PNG']);
        await drop(page, [file('SCAN.PDF', 'application/pdf')]);
        await expect.poll(async () => (await stateOf(page)).held).toEqual(['SCAN.PDF']);
        await drop(page, [file('notes.txt')]);
        await expect.poll(async () => (await stateOf(page)).refusals.length).toBe(1);
        await page.waitForTimeout(300);
        const s = await stateOf(page);
        expect(posts, 'the two matching files are sent, the third is not').toEqual([STAGE, STAGE]);
        expect(s.lines).toEqual([TYPE_LINE('notes.txt')]);
        expect(s.held).toEqual(['SCAN.PDF']);
    });
});
