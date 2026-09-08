'use strict';

/**
 * Playwright RUNTIME e2e for #B510 — a server-side field error on a name shared by
 * two controls whose HIDDEN twin comes first in document order (the real built gina
 * bundle, a real POST, the real 422 `{ error, fields }` answer, the real paint).
 *
 * The defect: handleErrorsDisplay walks the form in document order and, on the
 * per-field path (fieldName set), `break`s on the FIRST control whose name matches —
 * whether or not anything was painted. Every paint gate skips a bare hidden control,
 * so a hidden twin listed before its visible sibling consumes the error and the
 * visible one is never reached: no message, no aria-invalid, nothing.
 *
 * The pattern is the one the plugin's own source recommends (a hidden twin with
 * `"exclude": false` so a disabled control still posts), which is why it bites.
 *
 * WHY THIS LIVES IN test/e2e: the paint runs inside the COMMITTED minified bundle
 * against the real `$form.elements` collection order and the real XHR answer path;
 * jsdom cannot serve the built artifact and a replica of the walk would not prove
 * the served bytes.
 *
 * Arms (each a control for the others; 03-05 are RED before the fix):
 *   01 lone visible control          -> painted (the paint-chain control: sink hit, message, aria)
 *   02 VISIBLE first, hidden second  -> visible painted, hidden untouched (document-order control)
 *   03 hidden first, same box, DISABLED twin  -> the reported scene: visible twin must be painted
 *   04 hidden first, same box, ENABLED twin   -> drops the disabled dimension
 *   05 hidden first, twins in SEPARATE boxes  -> drops the shared-parent dimension
 *   06 a single bare hidden control  -> never receives a message (characterisation, must not change)
 *   07 a hidden control in a form-item-wrapper -> painted after the wrapper (the wrapper contract, must not change)
 *   08 the WHOLE-FORM path (a refused client-side submit, 3-argument call) on a shared box -> visible twin painted (RED before the fix)
 *
 * Subtract lever: B510_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the
 * bundle URL (page.route, zero disk mutation) so every arm can be re-run against the old bytes;
 * `routeHits` is the evidence the old bundle executed.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

const NAMES = ['shared', 'plain', 'split', 'visfirst', 'lone', 'hidonly', 'wrapped'];

/**
 * Per-name, per-control read of everything the paint could have touched, scoped to
 * the control's own `.form-item` box. Reports existence, text, geometry and the aria
 * wire separately (class-agnostic), plus a stuck-true control (a selector that must
 * never match) so a "0 messages" reading is a measurement, not a dead probe.
 */
function readState(page) {
    return page.evaluate((names) => {
        const form = document.getElementById('b510form');
        const out = {};
        names.forEach((n) => {
            out[n] = Array.prototype.map.call(form.querySelectorAll('[name="' + n + '"]'), (el) => {
                const box  = el.closest('.form-item');
                const msgs = box ? Array.prototype.slice.call(box.querySelectorAll('div.form-item-error-message')) : [];
                const next = el.nextElementSibling;
                return {
                    id          : el.id,
                    type        : el.type,
                    disabled    : el.disabled,
                    boxClass    : box ? box.className : null,
                    parentClass : el.parentNode.className,
                    ariaInvalid : el.getAttribute('aria-invalid'),
                    errMsgResolvable: !!(el.getAttribute('aria-errormessage') && document.getElementById(el.getAttribute('aria-errormessage'))),
                    errAttr     : el.getAttribute('data-gina-form-errors'),
                    msgCount    : msgs.length,
                    msgText     : msgs.map((m) => (m.textContent || '').trim()).join('|'),
                    msgHeight   : msgs.length ? msgs[0].getBoundingClientRect().height : null,
                    nextIsMsg   : !!(next && /form-item-error-message/.test(next.className))
                };
            });
        });
        const live = document.getElementById('gina-aria-live-b510form');
        const wrapper = document.getElementById('wrapped-w');
        return {
            fields  : out,
            live    : live ? (live.textContent || '').trim() : null,
            wrapperNextIsMsg: !!(wrapper && wrapper.nextElementSibling && /form-item-error-message/.test(wrapper.nextElementSibling.className)),
            bogus   : !!form.querySelector('div.zzz-bogus-never')
        };
    }, NAMES);
}

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B510_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B510_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/** Boot, submit, wait for the paint chain to complete (the `lone` control paints), read. */
async function scene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    let posts = 0;
    let sinkStatus = null;
    page.on('request', (r) => { if (r.url().indexOf('/hidden-first-sink') > -1 && r.method() === 'POST') posts++; });
    page.on('response', (r) => { if (r.url().indexOf('/hidden-first-sink') > -1) sinkStatus = r.status(); });

    await page.goto(BASE + 'hidden-first');
    await page.waitForFunction(() => !!(
        window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms
        && window.gina.validator.$forms['b510form']
    ), null, { timeout: 15000 });
    // the bind-time silent pass must leave the pre-filled form UN-gated, or the click never posts
    await page.waitForFunction(
        () => document.getElementById('b510form-submit').getAttribute('data-gina-form-submit-gated') !== 'true',
        null, { timeout: 10000 });

    await page.click('#b510form-submit');
    // The per-field passes run synchronously inside one XHR handler, so once the
    // control field is painted every field's pass has already run.
    await page.waitForFunction(
        () => !!document.querySelector('#fi-lone div.form-item-error-message'),
        null, { timeout: 8000 });
    await page.waitForTimeout(200);

    const state = await readState(page);
    state.posts = posts;
    state.sinkStatus = sinkStatus;
    state.pageErrors = pageErrors;
    state.consoleErrors = consoleErrors;
    state.routeHits = routeHits.n;
    if (process.env.B510_PREFIX_BUNDLE) expect(state.routeHits, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    expect(state.bogus, 'CONTROL FAILED: bogus selector matched (stuck true)').toBe(false);
    expect(state.posts, 'the submit never reached the sink').toBe(1);
    expect(state.sinkStatus, 'sink did not answer 422').toBe(422);
    expect(state.pageErrors, 'uncaught exception on the page').toEqual([]);
    return state;
}

/** The visible twin of a pair must carry the full committed-error paint. */
function expectPainted(ctl, text) {
    expect(ctl.msgCount, ctl.id + ': message count in its box').toBe(1);
    expect(ctl.msgText, ctl.id + ': message text').toBe(text);
    expect(ctl.msgHeight, ctl.id + ': message must be visible').toBeGreaterThan(1);
    expect(ctl.boxClass, ctl.id + ': box class').toMatch(/form-item-error/);
    expect(ctl.ariaInvalid, ctl.id + ': aria-invalid').toBe('true');
    expect(ctl.errMsgResolvable, ctl.id + ': aria-errormessage resolvable').toBe(true);
    expect(ctl.nextIsMsg, ctl.id + ': the message follows this control').toBe(true);
}

/** Arm 08's scene: boot both forms, click the SECOND form's enabled trigger (its pair fails a client rule). */
async function sceneWholeForm(page) {
    const routeHits = await maybeServePrefixBundle(page);
    let posts = 0;
    page.on('request', (r) => { if (r.url().indexOf('/hidden-first-sink') > -1 && r.method() === 'POST') posts++; });
    await page.goto(BASE + 'hidden-first');
    await page.waitForFunction(() => !!(
        window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms
        && window.gina.validator.$forms['b510form2']
    ), null, { timeout: 15000 });
    await page.click('#b510form2-submit');
    // the refused submit's LAST step focuses the first invalid field in document order,
    // skipping the hidden twin - the positive signal that the whole-form pass ran
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'wf-v', null, { timeout: 8000 });
    await page.waitForTimeout(200);
    const s = await page.evaluate(() => {
        const read = (id) => {
            const el = document.getElementById(id);
            const box = el.closest('.form-item');
            const msgs = Array.prototype.slice.call(box.querySelectorAll('div.form-item-error-message'));
            const next = el.nextElementSibling;
            return { id, boxClass: box.className, ariaInvalid: el.getAttribute('aria-invalid'), msgCount: msgs.length,
                     msgHeight: msgs.length ? msgs[0].getBoundingClientRect().height : null,
                     nextIsMsg: !!(next && /form-item-error-message/.test(next.className)) };
        };
        return { vis: read('wf-v'), hid: read('wf-h'), bogus: !!document.querySelector('div.zzz-bogus-never') };
    });
    s.posts = posts;
    s.routeHits = routeHits.n;
    if (process.env.B510_PREFIX_BUNDLE) expect(s.routeHits, 'the pre-fix bundle was not served').toBeGreaterThan(0);
    expect(s.bogus, 'CONTROL FAILED: bogus selector matched (stuck true)').toBe(false);
    expect(s.posts, 'a refused submit must not POST').toBe(0);
    return s;
}

test.describe('#B510 — a server field error reaches the visible twin of a hidden-first same-name pair', () => {

    test('01 paint-chain control: a lone visible control is painted', async ({ page }) => {
        const s = await scene(page);
        const [lone] = s.fields.lone;
        expectPainted(lone, 'lone error');
    });

    test('02 document-order control: visible first is painted, the hidden second is untouched', async ({ page }) => {
        const s = await scene(page);
        const vis = s.fields.visfirst.find((c) => c.type === 'text');
        const hid = s.fields.visfirst.find((c) => c.type === 'hidden');
        expectPainted(vis, 'visfirst error');
        expect(hid.ariaInvalid).toBeNull();
        expect(hid.nextIsMsg).toBe(false);
    });

    test('03 the reported scene: hidden first, same box, DISABLED visible twin', async ({ page }) => {
        const s = await scene(page);
        const vis = s.fields.shared.find((c) => c.type === 'text');
        expectPainted(vis, 'shared error');
    });

    test('04 hidden first, same box, ENABLED visible twin', async ({ page }) => {
        const s = await scene(page);
        const vis = s.fields.plain.find((c) => c.type === 'text');
        expectPainted(vis, 'plain error');
    });

    test('05 hidden first, twins in SEPARATE boxes', async ({ page }) => {
        const s = await scene(page);
        const vis = s.fields.split.find((c) => c.type === 'text');
        expectPainted(vis, 'split error');
    });

    test('06 characterisation: a single bare hidden control never receives a message', async ({ page }) => {
        const s = await scene(page);
        const [hid] = s.fields.hidonly;
        expect(hid.msgCount).toBe(0);
        expect(hid.ariaInvalid).toBeNull();
    });

    test('07 the wrapper contract: a hidden control in a form-item-wrapper is painted after the wrapper', async ({ page }) => {
        const s = await scene(page);
        const [hid] = s.fields.wrapped;
        expect(hid.msgCount).toBe(1);
        expect(hid.msgText).toBe('wrapped error');
        expect(s.wrapperNextIsMsg).toBe(true);
        expect(hid.boxClass).toMatch(/form-item-error/);
        expect(hid.ariaInvalid).toBeNull();
    });

    test('08 the WHOLE-FORM path: a refused client-side submit paints the visible twin on a shared box', async ({ page }) => {
        const s = await sceneWholeForm(page);
        expect(s.vis.msgCount, 'wf-v: message count in its box').toBe(1);
        expect(s.vis.msgHeight, 'wf-v: message must be visible').toBeGreaterThan(1);
        expect(s.vis.ariaInvalid, 'wf-v: aria-invalid').toBe('true');
        expect(s.vis.nextIsMsg, 'wf-v: the message follows the visible control').toBe(true);
        expect(s.vis.boxClass).toMatch(/form-item-error/);
        expect(s.hid.ariaInvalid).toBeNull();
        expect(s.hid.nextIsMsg).toBe(false);
    });

    test('99 dump: full state for the record', async ({ page }) => {
        const s = await scene(page);
        // eslint-disable-next-line no-console
        console.log('B510-STATE ' + JSON.stringify(s));
    });
});
