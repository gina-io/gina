'use strict';

/**
 * Playwright RUNTIME e2e for #B572 — a staged upload is placed by CONTAINMENT: the virtual
 * `gina-upload-*` form, its preview lookups and its staging request belong to the popin the
 * REAL form is inside, or to the page when it is inside none — never to "some popin is open".
 *
 * Before the fix the file-selection handler gated on `isPopinContext()` (any OPEN popin), so a
 * PAGE form staging a file while an unrelated popin was open got its virtual form appended
 * inside that popin: the staging POST succeeded, none of the ten generated hidden metadata
 * fields reached the form, the form then saved without the file, and the staging request
 * carried that popin's id in `X-Gina-Popin-Id`. Zero errors anywhere. A user reaches it through
 * the file-picker race (a popin opening while the OS picker is already up — the picker is
 * application-modal and ignores `inert`) or through script assigning `input.files`; the page
 * `inert` marking blocks only the click-driven path.
 *
 * Arms (each a control for the others):
 *   01 CONTROL page form, no popin       -> virtual form in BODY, 10/10 fields, no popin header
 *                                           (green on both trees)
 *   02 page form, unrelated popin OPEN   -> BODY, 10/10, no popin header          (RED pre-fix)
 *   03 form moved INSIDE that popin      -> DIALOG, 10/10, the header is that popin's id
 *                                           (green on both trees — the branch is still taken
 *                                           when containment says so)
 *   04 the file-picker RACE: file assigned, popin opens, THEN change fires
 *                                        -> BODY, 10/10                           (RED pre-fix)
 *
 * The dev-mode notice is deliberately NOT asserted here — the harness serves
 * `envIsDev: 'false'`; test/core/validator-upload-popin-containment.test.js owns it.
 *
 * Subtract lever: B572_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the
 * bundle URL (page.route, zero disk mutation); `routeHits` proves the old bytes ran.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-popin-containment.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// a 1x1 transparent PNG (69 bytes) — the staged file
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B572_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B572_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/** Boot the upload fixture and wire the sinks: page errors, staging status, staging popin header. */
async function boot(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const sink = { errors: [], stage: [], stageHeader: [], routeHits };
    page.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    page.on('response', (r) => { if (r.url().indexOf('/upload-stage') > -1) sink.stage.push(r.status()); });
    page.on('request', (r) => {
        if (r.url().indexOf('/upload-stage') > -1 && r.method() === 'POST') {
            const h = r.headers();
            sink.stageHeader.push(Object.prototype.hasOwnProperty.call(h, 'x-gina-popin-id') ? h['x-gina-popin-id'] : null);
        }
    });
    await page.goto(BASE + 'upload-preview');
    await page.waitForFunction(() => !!(
        window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']
    ), null, { timeout: 15000 });
    return sink;
}

/** Open an AJAX popin unrelated to the page form; returns its dialog id. */
async function openPopin(page) {
    await page.evaluate(() => {
        const a = document.createElement('a');
        a.id = 'b572-trigger';
        a.setAttribute('data-gina-dialog', 'b572');
        a.setAttribute('data-gina-dialog-src', '/frag/ajax.html');
        a.setAttribute('href', '#');
        a.textContent = 'open';
        document.body.appendChild(a);
    });
    await page.click('#b572-trigger');
    await expect(page.locator('dialog').filter({ hasText: 'AJAX loaded' })).toBeVisible();
    return page.evaluate(() => window.gina.popin.getActivePopin().id);
}

/** Put a real File on the input WITHOUT dispatching `change` (the OS picker has closed on a choice, the event has not fired yet). */
function assignFileNoDispatch(page) {
    return page.evaluate((b64) => {
        const inp = document.getElementById('docA');
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'me.png', { type: 'image/png' }));
        inp.files = dt.files;
        return inp.files.length;
    }, PNG_B64);
}

function fireChange(page) {
    return page.evaluate(() => document.getElementById('docA').dispatchEvent(new Event('change', { bubbles: true })));
}

/** Wait for the fill (the response's mandatory field landing in the REAL form); false on timeout, never a throw. */
function waitForFill(page) {
    return page.waitForFunction(() => {
        const el = document.querySelector('#b459form input[name="doc[0][location]"]');
        return !!(el && el.value === '/tmp/uploads/staged-me.png');
    }, null, { timeout: 10000 }).then(() => true).catch(() => false);
}

function readPlacement(page) {
    return page.evaluate(() => {
        const vf = document.querySelector('form[id^="gina-upload"]');
        const pf = document.getElementById('b459form');
        const fields = {};
        Array.prototype.forEach.call(pf.querySelectorAll('input[name^="doc[0]"]'), (el) => { fields[el.name] = el.value; });
        return {
            virtualParent: vf && vf.parentElement ? vf.parentElement.tagName : null,
            virtualInDialog: vf ? !!vf.closest('dialog') : null,
            filled: Object.keys(fields).filter((k) => fields[k] !== '').length,
            count: Object.keys(fields).length,
            location: fields['doc[0][location]'],
            // a selector that must never match — proves the reader is not stuck-true
            bogus: !!document.querySelector('form[id^="zzz-never-gina-upload"]')
        };
    });
}

function assertCommon(sink, placement) {
    if (process.env.B572_PREFIX_BUNDLE) expect(sink.routeHits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    expect(placement.bogus, 'CONTROL FAILED: bogus selector matched (stuck true)').toBe(false);
    expect(sink.stage, 'exactly one staging POST, answered 200').toEqual([200]);
    expect(sink.errors, 'uncaught exception on the page').toEqual([]);
}

test.describe('#B572 — a staged upload is placed by containment, never by "some popin is open"', () => {

    test('01 CONTROL — page form, no popin: virtual form in BODY, all ten fields filled, no popin header', async ({ page }) => {
        const sink = await boot(page);
        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        const filled = await waitForFill(page);
        await page.waitForTimeout(300);
        const p = await readPlacement(page);
        assertCommon(sink, p);
        expect(filled).toBe(true);
        expect(p.virtualParent).toBe('BODY');
        expect(p.filled).toBe(10);
        expect(p.count).toBe(10);
        expect(sink.stageHeader).toEqual([null]);
    });

    test('02 page form, an UNRELATED popin is open: the upload stays with the page form (RED pre-fix)', async ({ page }) => {
        const sink = await boot(page);
        const popinId = await openPopin(page);
        expect(popinId).toMatch(/^gina-popin-/);
        // script-assigned: inert blocks the click path, not this one (the autosave/timer shape)
        expect(await assignFileNoDispatch(page)).toBe(1);
        await fireChange(page);
        const filled = await waitForFill(page);
        await page.waitForTimeout(300);
        const p = await readPlacement(page);
        assertCommon(sink, p);
        // pre-fix: virtualParent 'DIALOG', filled 0, stageHeader [popinId]
        expect(p.virtualParent, 'the virtual form must live with the page form, not in the popin').toBe('BODY');
        expect(p.virtualInDialog).toBe(false);
        expect(filled, 'the staged metadata must reach the real form').toBe(true);
        expect(p.filled).toBe(10);
        expect(sink.stageHeader, 'the staging request must not claim a popin the form is not in').toEqual([null]);
    });

    test('03 form INSIDE the popin: placed in that popin, filled, and the staging request carries that popin\'s id (green on both trees)', async ({ page }) => {
        const sink = await boot(page);
        const popinId = await openPopin(page);
        // move the already-bound page form into the open dialog: containment and the old
        // "active popin" rule now AGREE, so this arm passes on both trees — it proves the
        // popin branch is still taken when containment says so, i.e. the fix did not simply
        // disable that branch
        await page.evaluate((id) => { document.getElementById(id).appendChild(document.getElementById('b459form')); }, popinId);
        expect(await page.evaluate(() => !!document.getElementById('b459form').closest('dialog'))).toBe(true);
        expect(await assignFileNoDispatch(page)).toBe(1);
        await fireChange(page);
        const filled = await waitForFill(page);
        await page.waitForTimeout(300);
        const p = await readPlacement(page);
        assertCommon(sink, p);
        expect(p.virtualParent).toBe('DIALOG');
        expect(p.virtualInDialog).toBe(true);
        expect(filled).toBe(true);
        expect(p.filled).toBe(10);
        expect(sink.stageHeader).toEqual([popinId]);
    });

    test('04 the file-picker RACE — file chosen, a popin opens underneath the picker, then change fires (RED pre-fix)', async ({ page }) => {
        const sink = await boot(page);
        expect(await assignFileNoDispatch(page)).toBe(1);   // the user has chosen in the OS dialog; no change yet
        await openPopin(page);                               // a popin opens while the picker is still up
        await fireChange(page);                              // the picker closes -> change fires with the popin open
        const filled = await waitForFill(page);
        await page.waitForTimeout(300);
        const p = await readPlacement(page);
        assertCommon(sink, p);
        expect(p.virtualParent).toBe('BODY');
        expect(filled).toBe(true);
        expect(p.filled).toBe(10);
        expect(sink.stageHeader).toEqual([null]);
    });
});
