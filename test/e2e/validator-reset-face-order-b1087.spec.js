'use strict';

/**
 * Playwright RUNTIME e2e for #B1087 — a form reset runs a form-associated custom element's own
 * `formResetCallback` as a native reset does: once every other control is restored, and only for a
 * component still among the form's `elements` (the real built gina bundle, a real form, `form.reset()`
 * and the handle's `.resetFields()`).
 *
 * The defects (#B1041's cold read): `resetFields` ran each component's callback inside its restore loop,
 * so a callback reading a sibling field saw the value before the reset, where a native reset runs the
 * callbacks after it has reset every control; and a component moved into another form after the bind
 * was still reset by its OLD form, because the `form` property the bind gave it still named that form,
 * where a native reset of the old form leaves it alone.
 *
 * The fix: the loop collects the components and calls their callbacks after it, still before the reset's
 * pass; a component that is no longer among the form's `elements` is skipped.
 *
 * The instrument: the component's callback records the text field's value when it runs and counts its
 * calls. The native controls run the same page without gina, so each expected value is the platform's.
 *
 *   01 a component whose callback reads a sibling, the sibling typed into, form.reset()  -> it reads the
 *      restored value                                                              (RED before the fix)
 *   02 the same, the handle's resetFields()                                        (RED)
 *   03 CONTROL the same page without gina, form.reset(): the native reset's reading
 *   04 a component moved into another form after the bind, the OLD form's form.reset() -> its callback
 *      does not run and it keeps its value                                         (RED)
 *   05 CONTROL the same move without gina: the native reset of the old form leaves it alone
 *   06 CONTROL a component associated through its `form` attribute, outside the form element: still
 *      among the form's `elements`, so the form's reset runs its callback
 *
 * Pre-fix arm: `GINA_B1087_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle instead of
 * the working-tree dist (the plugins subtract recipe).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PREFIX_BUNDLE = process.env.GINA_B1087_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1087_PREFIX_BUNDLE) : null;

/** Calls `onGinaLoaded` once the loader and the bundle are both in, as the other /x76-page specs do. */
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const BUTTONS = '<button id="facer-reset" type="reset">Reset</button><button id="facer-submit" type="submit">Save</button>';

/** The component inside the form, before the text field it reads. */
const FORM = '<form id="facer" data-gina-form-rule="facer" action="/ac-sink" method="post">'
    + '<div><x-rating id="score" name="score"></x-rating></div>'
    + '<div><input id="r3" type="text" name="r3" value="seed"></div>' + BUTTONS + '</form>';

/** A second form the component is moved into. */
const OTHER = '<form id="other" action="/ac-sink" method="post"><button type="reset" id="other-reset">R</button></form>';

/** The component outside the form element, associated with it through its `form` attribute. */
const FORM_ATTR = '<form id="facer" data-gina-form-rule="facer" action="/ac-sink" method="post">'
    + '<div><input id="r3" type="text" name="r3" value="seed"></div>' + BUTTONS + '</form>'
    + '<div><x-rating id="score" name="score" form="facer"></x-rating></div>';

/**
 * Defines `x-rating`, a form-associated custom element whose value is '' until `commit(v)`; runs in the
 * page before its scripts. Its `formResetCallback` counts its calls, records the text field's value at
 * that moment and empties the component.
 *
 * @returns {undefined}
 */
function defineRating() {
    window.__faceResetCalls = 0;
    window.__faceResetSaw = [];
    class XRating extends HTMLElement {
        static get formAssociated() { return true; }
        constructor() { super(); this.internals_ = this.attachInternals(); this._v = ''; }
        get value() { return this._v; }
        set value(v) { this._v = v; this.internals_.setFormValue(v); }
        commit(v) { this.value = v; this.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
    }
    XRating.prototype.formResetCallback = function () {
        window.__faceResetCalls++;
        var r3 = document.getElementById('r3');
        window.__faceResetSaw.push(r3 ? r3.value : null);
        this.value = '';
    };
    customElements.define('x-rating', XRating);
}

/**
 * Serves `body` through /x76-page with `x-rating` defined; with gina, waits for the form to be bound and
 * its bind-time pass to have settled.
 *
 * @param {object} page
 * @param {string} body
 * @param {boolean} withGina - false runs the same page without gina: the native reset's control
 * @returns {Promise<{errors: string[], prefix: number}>} uncaught errors, and how many times the
 *   pre-fix bundle was served
 */
async function open(page, body, withGina) {
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (withGina && PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.addInitScript(defineRating);
    const head = withGina
        ? '<script src="/js/gina.onload.b1041.js"></script><script src="/js/gina.min.js"></script><script>' + KICKER + '</script>'
        : '';
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1087</title><link rel="icon" href="data:,">'
        + head + '</head><body>' + body + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    if (withGina) {
        await page.waitForFunction(() => !!(
            window.gina
            && window.gina.isFrameworkLoaded === true
            && window.gina.validator
            && window.gina.validator.$forms
            && window.gina.validator.$forms.facer
            && window.gina.validator.$forms.facer.binded
        ), null, { timeout: 15000 });
        if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    }
    await page.waitForTimeout(600);
    return seen;
}

/** Commits a value on the component as a person's pick does, and lets the live check run. */
async function commit(page, v) {
    await page.evaluate((value) => { document.getElementById('score').commit(value); }, v);
    await page.waitForTimeout(450);
}

/** Resets the form by `form.reset()` or by the handle's `resetFields()`, then lets every timer of the reset run. */
async function reset(page, way) {
    await page.evaluate((w) => {
        if (w === 'resetFields') { window.gina.validator.$forms.facer.resetFields(); } else { document.getElementById('facer').reset(); }
    }, way);
    await page.waitForTimeout(800);
}

/**
 * The callback's call count and what it read of the text field, the component's value and owner, and
 * the text field's value.
 *
 * @param {object} page
 * @returns {Promise<{calls: number, saw: Array<string|null>, score: string, owner: string|null, r3: string}>}
 */
function read(page) {
    return page.evaluate(() => {
        const el = document.getElementById('score');
        return {
            calls: window.__faceResetCalls,
            saw: window.__faceResetSaw.slice(),
            score: el.value,
            owner: el.internals_.form ? el.internals_.form.id : null,
            r3: document.getElementById('r3').value
        };
    });
}

test.describe('#B1087 — a reset runs a component\'s formResetCallback after the other controls, and only for its own form', () => {

    for (const way of ['form.reset', 'resetFields']) {
        const label = ( way === 'form.reset' ) ? '01' : '02';
        test(label + ' a component whose callback reads a sibling, the sibling typed into, then ' + way + '(): it reads the restored value', async ({ page }) => {
            const seen = await open(page, FORM, true);
            await commit(page, '5');
            await page.locator('#r3').fill('typed');
            await page.locator('#r3').press('Tab');
            await page.waitForTimeout(450);
            const typed = await read(page);
            await reset(page, way);
            const after = await read(page);

            expect(typed.r3, 'the sibling holds the typed value before the reset').toBe('typed');
            expect(after.calls, 'the reset ran the callback, once').toBe(1);
            expect(after.saw, 'which read the sibling\'s restored value, as under a native reset').toEqual(['seed']);
            expect(after.r3).toBe('seed');
            expect(after.score, 'and the callback restored the component').toBe('');
            expect(seen.errors).toEqual([]);
        });
    }

    test('03 CONTROL the same page without gina, form.reset(): the native reset runs the callback after the sibling is restored', async ({ page }) => {
        const seen = await open(page, FORM, false);
        await commit(page, '5');
        await page.locator('#r3').fill('typed');
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(after.calls).toBe(1);
        expect(after.saw, 'the native reading').toEqual(['seed']);
        expect(after.score).toBe('');
        expect(seen.errors).toEqual([]);
    });

    test('04 a component moved into another form after the bind, the old form\'s form.reset(): its callback does not run', async ({ page }) => {
        const seen = await open(page, FORM + OTHER, true);
        await page.evaluate(() => {
            const el = document.getElementById('score');
            document.getElementById('other').insertBefore(el, document.getElementById('other-reset'));
        });
        await commit(page, '5');
        const moved = await read(page);
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(moved.owner, 'the component now belongs to the other form').toBe('other');
        expect(moved.score).toBe('5');
        expect(after.calls, 'the old form\'s reset leaves it alone').toBe(0);
        expect(after.score, 'so it keeps its value').toBe('5');
        expect(after.r3, 'while the old form\'s own field is restored').toBe('seed');
        expect(seen.errors).toEqual([]);
    });

    test('05 CONTROL the same move without gina: the native reset of the old form leaves the component alone', async ({ page }) => {
        const seen = await open(page, FORM + OTHER, false);
        await page.evaluate(() => {
            const el = document.getElementById('score');
            document.getElementById('other').insertBefore(el, document.getElementById('other-reset'));
        });
        await commit(page, '5');
        const moved = await read(page);
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(moved.owner).toBe('other');
        expect(after.calls, 'the native reading').toBe(0);
        expect(after.score).toBe('5');
        expect(seen.errors).toEqual([]);
    });

    test('06 CONTROL a component associated through its form attribute, outside the form element: the form\'s reset runs its callback', async ({ page }) => {
        const seen = await open(page, FORM_ATTR, true);
        await commit(page, '5');
        const committed = await read(page);
        await reset(page, 'form.reset');
        const after = await read(page);

        expect(committed.owner, 'the form attribute associates it with the form').toBe('facer');
        expect(committed.score).toBe('5');
        expect(after.calls, 'it is among the form\'s elements: its callback runs').toBe(1);
        expect(after.score).toBe('');
        expect(seen.errors).toEqual([]);
    });
});
