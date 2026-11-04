'use strict';

/**
 * Playwright RUNTIME e2e for the staged-upload DRAG-AND-DROP path (#R8 slice 2).
 *
 * WHY THIS EXISTS. bindUploadDropzone() reacts only to FILE drags — it reads
 * `event.dataTransfer.types` and ignores text/link drags — then drives
 * `data-gina-upload-dropzone-state` (idle -> over -> dropped) and assigns the dropped
 * FileList to the owning `<input type="file">`. None of that is reachable from the
 * node --test suite: it runs in jsdom, which implements NO `DataTransfer`, so the
 * drag events cannot even be CONSTRUCTED there, let alone carry files. The existing
 * unit file (test/core/validator-upload-dropzone.test.js) therefore covers the
 * surrounding wiring, never the drop behaviour itself.
 *
 * INSTRUMENT DISCIPLINE. §03 is a subtract arm: a non-file drag must leave the state
 * untouched. Without it §02 would pass for a dropzone that flips to `over` on ANY
 * drag — i.e. one whose `types` check had been lost — and the suite would still be
 * green. §02 doubles as the positive control for §03: if the state never changes for
 * a file drag either, the probe observes nothing and both readings are void.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-dropzone.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/upload';

/** Navigate and wait for the validator to have bound the form. */
async function gotoAndBind(page) {
    await page.goto(BASE);
    // The dropzone stamp IS the bind signal: bindUploadDropzone() writes it during
    // form binding, so waiting on it avoids racing the boot without a fixed sleep.
    await page.waitForFunction(
        () => !!document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone'),
        null,
        { timeout: 15000 }
    );
}

/**
 * Dispatch a drag event on the dropzone.
 * @param {string} type   dragenter | dragover | dragleave | drop
 * @param {string} kind   'file' -> a real File rides the DataTransfer; 'text' -> a
 *                        plain text/plain payload, which the handler must ignore.
 */
async function dispatchDrag(page, type, kind) {
    return await page.evaluate((a) => {
        const dt = new DataTransfer();
        if (a.kind === 'file') {
            dt.items.add(new File(['hello dropped world'], 'dropped.txt', { type: 'text/plain' }));
        } else {
            dt.setData('text/plain', 'just some dragged text');
        }
        const zone = document.getElementById('drop-zone');
        zone.dispatchEvent(new DragEvent(a.type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        return Array.from(dt.types);
    }, { type: type, kind: kind });
}

const stateOf = (page) => page.evaluate(
    () => document.getElementById('drop-zone').getAttribute('data-gina-upload-dropzone-state')
);

test.beforeEach(async ({ page }) => {
    await gotoAndBind(page);
});

test.describe('#R8 staged-upload dropzone (real bundle, real DataTransfer)', () => {

    test('01 - binding: the zone is stamped with its owner input and starts idle', async ({ page }) => {
        const zone = await page.evaluate(() => {
            const z = document.getElementById('drop-zone');
            return {
                owner: z.getAttribute('data-gina-upload-dropzone'),
                state: z.getAttribute('data-gina-upload-dropzone-state')
            };
        });

        expect(zone.owner, 'the zone must be bound to the file input that named it').toBe('doc');
        expect(zone.state, 'a bound zone starts idle').toBe('idle');
    });

    test('02 - a FILE drag flips the zone to `over`', async ({ page }) => {
        const types = await dispatchDrag(page, 'dragenter', 'file');
        // Guard the fixture itself: if the synthesised DataTransfer did not carry
        // Files, this test would be probing the wrong thing entirely.
        expect(types, 'the synthesised drag must actually carry Files').toContain('Files');

        await expect.poll(() => stateOf(page)).toBe('over');
    });

    test('03 - SUBTRACT: a non-file drag leaves the state untouched', async ({ page }) => {
        const types = await dispatchDrag(page, 'dragenter', 'text');
        expect(types, 'the text drag must NOT carry Files').not.toContain('Files');

        // A dropzone that flipped on any drag would still pass §02. This is what
        // makes §02 meaningful rather than merely green.
        await page.waitForTimeout(150);
        expect(await stateOf(page), 'a text/link drag must not arm the dropzone').toBe('idle');
    });

    test('04 - a dropped file is assigned to the owning input', async ({ page }) => {
        // #B1059 — read the input at its `change`, the moment the drop assigns the file: this fixture's
        // staging always fails (no upload action, the default route is not served: POST /null, 404), and
        // a failed staging now empties the input, so a read after it saw nothing (approved by Martin
        // Luther ETOUMAN NDAMBWE, 2026-11-04, by 18:46:27 WAT).
        // was: the poll below read `el.files` after the drop, whatever the staging had done meanwhile
        await page.evaluate(() => {
            window.__droppedAtChange = [];
            document.getElementById('doc').addEventListener('change', (e) => {
                window.__droppedAtChange.push(e.target.files && e.target.files.length ? e.target.files[0].name : null);
            }, true);
        });
        await dispatchDrag(page, 'dragenter', 'file');
        await dispatchDrag(page, 'dragover', 'file');
        await dispatchDrag(page, 'drop', 'file');

        // The behavioural payoff: the drop must reach the <input type="file">, which
        // is what makes the dropped file part of the eventual submission.
        await expect.poll(async () => await page.evaluate(() => window.__droppedAtChange[0] || null)).toBe('dropped.txt');
    });
});
