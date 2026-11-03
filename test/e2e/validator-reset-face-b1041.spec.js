'use strict';

/**
 * Playwright RUNTIME e2e for #B1041 — a form reset restores a form-associated custom element through its
 * own `formResetCallback` (the real built gina bundle, a real form, `form.reset()` and the handle's
 * `.resetFields()`).
 *
 * The defect: gina cancels the native reset and restores the bound controls itself (`resetFields`), and
 * that loop had no branch for a custom element. The native reset runs each form-associated custom
 * element's `formResetCallback`; under gina it never ran, so a component kept the value of the last
 * commit after a reset, and the reset's pass read that value (the submit control stayed open on an
 * emptied required component).
 *
 * The fix: the loop calls the element's `formResetCallback` when it has one. A component without one
 * keeps its value, as a native reset leaves it. A callback that throws is reported, as the browser
 * reports one, and the other fields are still restored.
 *
 * The instrument: the component counts its callback's calls; its value, a text field's value and the
 * submit control's gate are read before and after. A form-associated custom element is bound before the
 * inputs, so a text field restored after a throwing callback shows that the loop went on.
 *
 *   01 a component with a formResetCallback, a value committed, form.reset()  -> called once, value and
 *      gate back to their state at bind                                          (RED before the fix)
 *   02 the same, the handle's resetFields()                                      (RED)
 *   03 CONTROL a component without the callback, form.reset(): it keeps its value, the text field is
 *      restored and the gate re-read
 *   04 a callback that throws, form.reset(): reported once, the text field restored after it, the gate
 *      re-read                                                                   (RED: never called)
 *
 * Pre-fix arm: `GINA_B1041_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle instead of
 * the working-tree dist (the plugins subtract recipe).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PREFIX_BUNDLE = process.env.GINA_B1041_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1041_PREFIX_BUNDLE) : null;

/** Calls `onGinaLoaded` once the loader and the bundle are both in, as the other /x76-page specs do. */
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const THROWN = 'b1041: the reset callback threw';

const FORM = '<form id="facer" data-gina-form-rule="facer" action="/ac-sink" method="post">'
    + '<div><x-rating id="score" name="score"></x-rating></div>'
    + '<div><input id="r3" type="text" name="r3" value="seed"></div>'
    + '<button id="facer-reset" type="reset">Reset</button><button id="facer-submit" type="submit">Save</button></form>';

/**
 * Defines `x-rating`, a form-associated custom element whose value is '' until `commit(v)`; runs in the
 * page before its scripts. `kind` picks its `formResetCallback`: 'counting' counts the call and empties
 * the value, 'none' has no callback, 'throwing' counts the call and throws.
 *
 * @param {{kind: string, thrown: string}} opts
 * @returns {undefined}
 */
function defineRating(opts) {
    window.__faceResetCalls = 0;
    class XRating extends HTMLElement {
        static get formAssociated() { return true; }
        constructor() { super(); this.internals_ = this.attachInternals(); this._v = ''; }
        get value() { return this._v; }
        set value(v) { this._v = v; this.internals_.setFormValue(v); }
        commit(v) { this.value = v; this.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
    }
    if (opts.kind === 'counting') {
        XRating.prototype.formResetCallback = function () { window.__faceResetCalls++; this.value = ''; };
    } else if (opts.kind === 'throwing') {
        XRating.prototype.formResetCallback = function () { window.__faceResetCalls++; throw new Error(opts.thrown); };
    }
    customElements.define('x-rating', XRating);
}

/**
 * Serves the page through /x76-page with `x-rating` defined as `kind` asks, and waits for the form to be
 * bound and its bind-time pass to have settled.
 *
 * @param {object} page
 * @param {string} kind - 'counting', 'none' or 'throwing'
 * @returns {Promise<{errors: string[], prefix: number}>} uncaught errors, and how many times the
 *   pre-fix bundle was served
 */
async function open(page, kind) {
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.addInitScript(defineRating, { kind: kind, thrown: THROWN });
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1041</title><link rel="icon" href="data:,">'
        + '<script src="/js/gina.onload.b1041.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + FORM + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await page.waitForFunction(() => !!(
        window.gina
        && window.gina.isFrameworkLoaded === true
        && window.gina.validator
        && window.gina.validator.$forms
        && window.gina.validator.$forms.facer
        && window.gina.validator.$forms.facer.binded
    ), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/**
 * The component's value, the text field's value, the callback's call count and the submit control's
 * gate mark ('true' while gated).
 *
 * @param {object} page
 * @returns {Promise<{score: string, r3: string, calls: number, gated: string|null}>}
 */
function read(page) {
    return page.evaluate(() => ({
        score: document.getElementById('score').value,
        r3: document.getElementById('r3').value,
        calls: window.__faceResetCalls,
        gated: document.getElementById('facer-submit').getAttribute('data-gina-form-submit-gated')
    }));
}

/** Commits a value on the component as a person's pick does, and lets the live check run. */
async function commit(page, v) {
    await page.evaluate((value) => { document.getElementById('score').commit(value); }, v);
    await page.waitForTimeout(450);
}

/** Empties the text field as a person does (the keys, then a Tab), and lets the live check run. */
async function emptyText(page) {
    await page.locator('#r3').fill('');
    await page.locator('#r3').press('Tab');
    await page.waitForTimeout(1300);
}

/** Resets the form by `form.reset()` or by the handle's `resetFields()`, then lets every timer of the reset run. */
async function reset(page, way) {
    await page.evaluate((w) => {
        if (w === 'resetFields') { window.gina.validator.$forms.facer.resetFields(); } else { document.getElementById('facer').reset(); }
    }, way);
    await page.waitForTimeout(800);
}

test.describe('#B1041 — a reset restores a form-associated custom element through its formResetCallback', () => {

    for (const way of ['form.reset', 'resetFields']) {
        const label = ( way === 'form.reset' ) ? '01' : '02';
        test(label + ' a component with a formResetCallback, a value committed, then ' + way + '(): called once, the form reads as bound', async ({ page }) => {
            const seen = await open(page, 'counting');
            const bound = await read(page);
            await commit(page, '5');
            const committed = await read(page);
            await reset(page, way);
            const after = await read(page);

            expect(bound.score, 'bound: the component is empty').toBe('');
            expect(bound.gated, 'the required component is empty: gated').toBe('true');
            expect(committed.score).toBe('5');
            expect(committed.gated, 'the commit opened the gate, or the arm proves nothing').not.toBe('true');
            expect(after.calls, 'the reset ran the component\'s formResetCallback, once').toBe(1);
            expect(after.score, 'which restored its value').toBe('');
            expect(after.gated, 'and the reset\'s pass read it: gated again').toBe('true');
            expect(after.r3).toBe('seed');
            expect(seen.errors).toEqual([]);
        });
    }

    test('03 CONTROL a component without a formResetCallback, form.reset(): it keeps its value, the rest is restored', async ({ page }) => {
        const seen = await open(page, 'none');
        await commit(page, '5');
        await emptyText(page);
        const changed = await read(page);
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(changed.score).toBe('5');
        expect(changed.r3).toBe('');
        expect(changed.gated, 'the emptied required text field gates the form').toBe('true');
        expect(after.score, 'no callback: the component keeps its value, as a native reset leaves it').toBe('5');
        expect(after.r3, 'the text field is restored').toBe('seed');
        expect(after.gated, 'and the reset\'s pass opened the gate').not.toBe('true');
        expect(seen.errors).toEqual([]);
    });

    test('04 a formResetCallback that throws, form.reset(): reported once, the text field still restored, the gate re-read', async ({ page }) => {
        const seen = await open(page, 'throwing');
        await commit(page, '5');
        await emptyText(page);
        const changed = await read(page);
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(changed.r3).toBe('');
        expect(changed.gated, 'the emptied required text field gates the form').toBe('true');
        expect(after.calls, 'the reset ran the callback, once').toBe(1);
        expect(seen.errors, 'its error is reported, once').toEqual([THROWN]);
        expect(after.r3, 'the loop went on past the throw: the text field is restored').toBe('seed');
        expect(after.gated, 'and the reset\'s pass ran: the gate is open again').not.toBe('true');
    });
});
