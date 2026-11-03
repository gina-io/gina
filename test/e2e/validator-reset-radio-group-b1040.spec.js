'use strict';

/**
 * Playwright RUNTIME e2e for #B1040 — a form reset re-applies the group of each RADIO master, so the
 * fields that name a radio follow its restored state (the real built gina bundle, a real form, real
 * clicks, `form.reset()` and the handle's `.resetFields()`).
 *
 * The defect: a field carrying `data-gina-form-element-group` is enabled only while its master is
 * checked. A reset restores each radio's `checked`, but nothing on the reset path re-applied a radio
 * master's group: a radio listens on its bare id and on the click proxy, never on `change`, and the
 * live listeners are held off during the reset. So after picking the radio a field names and
 * resetting, the radio was unchecked again while its field stayed enabled — sent with the form, and
 * counted by the submit control's gate (gated on a valid form when the field is required). A
 * checkbox master was not affected: its `change.<id>` listener applies its group on a timer.
 *
 * The fix: the bind leaves a hook on the form's record that applies every radio's group as the bind
 * does; the reset calls it after restoring the values and before its one pass. A checkbox master's
 * timer, which runs after the reset's pass, calls it again before it re-reads the gate, so a checkbox
 * grouped under a radio cannot re-enable a field its unchecked radio turned off.
 *
 * The instrument: a snapshot of every control of the form (checked, disabled, value) and of the
 * submit control's gate, read once the form is bound; after the arm's clicks and the reset, the form
 * must read that same snapshot again. Each arm first asserts that its clicks moved the state, so a
 * snapshot equal to the bound one cannot come from clicks that never landed.
 *
 *   01 a field naming a radio; the radio picked, form.reset()             -> as bound   (RED before the fix)
 *   02 the same, the handle's resetFields()                                -> as bound   (RED)
 *   03 a checkbox under a radio master (unticked in the markup) and a
 *      field naming both; radio picked, box ticked, form.reset()           -> as bound   (RED)
 *   04 the same with the box ticked in the markup                          -> as bound   (RED)
 *   05 a field naming two radios of two groups; both picked, form.reset()  -> as bound   (RED)
 *   06 reBind(), then the radio picked, form.reset()                       -> as bound   (RED)
 *   07 CONTROL a checkbox master unticked, form.reset(): its required field is back and the gate closes
 *   08 CONTROL no reset: picking the radio enables its field, picking its peer disables it
 *
 * Pre-fix arm: `GINA_B1040_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle
 * instead of the working-tree dist (the plugins subtract recipe).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PREFIX_BUNDLE = process.env.GINA_B1040_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1040_PREFIX_BUNDLE) : null;

/** Calls `onGinaLoaded` once the loader and the bundle are both in, as the other /x76-page specs do. */
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const wrap = (inner) => '<div>' + inner + '</div>';
const form = (id, controls) => '<form id="' + id + '" data-gina-form-rule="' + id + '" action="/ac-sink" method="post">'
    + wrap('<input id="r3" type="text" name="r3" value="seed">') + controls
    + '<button id="' + id + '-reset" type="reset">Reset</button><button id="' + id + '-submit" type="submit">Save</button></form>';

const PLAN = wrap('<input id="pm" type="radio" name="plan" value="m" checked>') + wrap('<input id="pa" type="radio" name="plan" value="a">');
const GRPR = form('grpr', PLAN + wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="pa">'));
const underRadio = (id, isBoxTicked) => form(id, PLAN
    + wrap('<input id="cb" type="checkbox" name="cb" value="yes" data-gina-form-element-group="pa"' + (isBoxTicked ? ' checked' : '') + '>')
    + wrap('<input id="cc" type="text" name="cc" data-gina-form-element-group="pa cb">'));
const GRP2 = form('grp2', PLAN
    + wrap('<input id="sm" type="radio" name="ship" value="m" checked>') + wrap('<input id="sa" type="radio" name="ship" value="a">')
    + wrap('<input id="both" type="text" name="both" data-gina-form-element-group="pa sa">'));
const GRPK = form('grpk', wrap('<input id="m" type="checkbox" name="m" checked>') + wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="m">'));

/**
 * Serves the page through /x76-page and waits for the form to be bound and its bind-time pass to
 * have settled.
 *
 * @param {object} page
 * @param {string} formHtml
 * @param {string} id - the form's id
 * @returns {Promise<{errors: string[], prefix: number}>} uncaught errors, and how many times the
 *   pre-fix bundle was served
 */
async function open(page, formHtml, id) {
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1040</title><link rel="icon" href="data:,">'
        + '<script src="/js/gina.onload.b1040.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + formHtml + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await page.waitForFunction((fid) => !!(
        window.gina
        && window.gina.isFrameworkLoaded === true
        && window.gina.validator
        && window.gina.validator.$forms
        && window.gina.validator.$forms[fid]
        && window.gina.validator.$forms[fid].binded
    ), id, { timeout: 15000 });
    await page.waitForTimeout(600);
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/**
 * Every control of the form with its checked, disabled and value state, and the submit control's
 * gate mark ('true' while gated).
 *
 * @param {object} page
 * @param {string} id - the form's id
 * @returns {Promise<{controls: object, gated: string|null}>}
 */
function snapshot(page, id) {
    return page.evaluate((fid) => {
        const f = document.getElementById(fid);
        const controls = {};
        for (let i = 0; i < f.elements.length; i++) {
            const e = f.elements[i];
            if (!e.id || /^(submit|reset|button)$/i.test(e.type)) { continue; }
            const state = ( /^(checkbox|radio)$/i.test(e.type) ) ? ( e.checked ? 'checked' : 'unchecked' ) : 'value=' + e.value;
            controls[e.id] = state + ( e.disabled ? ' disabled' : ' enabled' );
        }
        return { controls: controls, gated: document.getElementById(fid + '-submit').getAttribute('data-gina-form-submit-gated') };
    }, id);
}

/** Clicks a control as a person does, and lets the deferred group pass run. */
async function pick(page, selector) {
    await page.locator(selector).click();
    await page.waitForTimeout(450);
}

/** Resets the form by `form.reset()` or by the handle's `resetFields()`, then lets every timer of the reset run. */
async function reset(page, id, way) {
    await page.evaluate(([fid, w]) => {
        if (w === 'resetFields') { window.gina.validator.$forms[fid].resetFields(); } else { document.getElementById(fid).reset(); }
    }, [id, way]);
    await page.waitForTimeout(800);
}

test.describe('#B1040 — a reset re-applies each radio master\'s group', () => {

    for (const way of ['form.reset', 'resetFields']) {
        const label = ( way === 'form.reset' ) ? '01' : '02';
        test(label + ' a field naming a radio; the radio picked, then ' + way + '(): the form reads as bound', async ({ page }) => {
            const seen = await open(page, GRPR, 'grpr');
            const bound = await snapshot(page, 'grpr');
            await pick(page, '#pa');
            const picked = await snapshot(page, 'grpr');
            await reset(page, 'grpr', way);
            const after = await snapshot(page, 'grpr');

            expect(bound.controls.dep, 'bound: the field follows its unchecked radio').toBe('value= disabled');
            expect(picked.controls.dep, 'the pick enabled the field, or the arm proves nothing').toBe('value= enabled');
            expect(picked.gated, 'the required field is empty: gated').toBe('true');
            expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
            expect(after.gated, 'and the gate with it').toBe(bound.gated);
            expect(seen.errors).toEqual([]);
        });
    }

    for (const isBoxTicked of [false, true]) {
        const label = isBoxTicked ? '04' : '03';
        const id = isBoxTicked ? 'grpct' : 'grpc';
        test(label + ' a checkbox under a radio master, ' + (isBoxTicked ? 'ticked' : 'unticked') + ' in the markup, and a field naming both: form.reset(), the form reads as bound', async ({ page }) => {
            const seen = await open(page, underRadio(id, isBoxTicked), id);
            const bound = await snapshot(page, id);
            await pick(page, '#pa');
            if (!isBoxTicked) { await pick(page, '#cb'); }
            const picked = await snapshot(page, id);
            await reset(page, id, 'form.reset');
            const after = await snapshot(page, id);

            expect(bound.controls.cb, 'bound: the box follows its unchecked radio').toBe(( isBoxTicked ? 'checked' : 'unchecked' ) + ' disabled');
            expect(bound.controls.cc, 'bound: a field naming both is off').toBe('value= disabled');
            expect(picked.controls.cb, 'radio picked, box ticked').toBe('checked enabled');
            expect(picked.controls.cc, 'the field naming both is on, or the arm proves nothing').toBe('value= enabled');
            expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
            expect(after.gated, 'and the gate with it').toBe(bound.gated);
            expect(seen.errors).toEqual([]);
        });
    }

    test('05 a field naming two radios of two groups; both picked, form.reset(): the form reads as bound', async ({ page }) => {
        const seen = await open(page, GRP2, 'grp2');
        const bound = await snapshot(page, 'grp2');
        await pick(page, '#pa');
        await pick(page, '#sa');
        const picked = await snapshot(page, 'grp2');
        await reset(page, 'grp2', 'form.reset');
        const after = await snapshot(page, 'grp2');

        expect(bound.controls.both, 'bound: off').toBe('value= disabled');
        expect(picked.controls.both, 'the picks enabled it, or the arm proves nothing').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('06 reBind(), then the radio picked, form.reset(): the form reads as bound', async ({ page }) => {
        const seen = await open(page, GRPR, 'grpr');
        const bound = await snapshot(page, 'grpr');
        await page.evaluate(() => { window.gina.validator.$forms.grpr.reBind(); });
        await page.waitForTimeout(600);
        await pick(page, '#pa');
        const picked = await snapshot(page, 'grpr');
        await reset(page, 'grpr', 'form.reset');
        const after = await snapshot(page, 'grpr');

        expect(picked.controls.dep, 'the pick enabled the field, or the arm proves nothing').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('07 CONTROL a checkbox master unticked, form.reset(): its required field is back and the gate closes', async ({ page }) => {
        const seen = await open(page, GRPK, 'grpk');
        const bound = await snapshot(page, 'grpk');
        await pick(page, '#m');
        const unticked = await snapshot(page, 'grpk');
        await reset(page, 'grpk', 'form.reset');
        const after = await snapshot(page, 'grpk');

        expect(bound.controls.dep, 'bound: the master is ticked, its field on').toBe('value= enabled');
        expect(bound.gated, 'the required field is empty: gated').toBe('true');
        expect(unticked.controls.dep, 'unticking turns the field off').toBe('value= disabled');
        expect(unticked.gated, 'and opens the gate').not.toBe('true');
        expect(after.controls.m).toBe('checked enabled');
        expect(after.controls.dep, 'the reset ticks the master again: its field is back').toBe('value= enabled');
        expect(after.gated, 'the gate closes again').toBe('true');
        expect(seen.errors).toEqual([]);
    });

    test('08 CONTROL no reset: picking the radio enables its field, picking its peer disables it', async ({ page }) => {
        const seen = await open(page, GRPR, 'grpr');
        await pick(page, '#pa');
        const onPick = await snapshot(page, 'grpr');
        await pick(page, '#pm');
        const onPeer = await snapshot(page, 'grpr');

        expect(onPick.controls.dep).toBe('value= enabled');
        expect(onPick.gated).toBe('true');
        expect(onPeer.controls.dep).toBe('value= disabled');
        expect(onPeer.gated).not.toBe('true');
        expect(seen.errors).toEqual([]);
    });
});
