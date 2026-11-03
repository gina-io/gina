'use strict';

/**
 * Playwright RUNTIME e2e for #B1040 — a form reset applies the group of every radio and checkbox
 * again, as the bind applied them at page load, so the fields that name them come back to their
 * page-load state (the real built gina bundle, a real form, real clicks, `form.reset()` and the
 * handle's `.resetFields()`).
 *
 * The defect: a field carrying `data-gina-form-element-group` is enabled only while its master is
 * checked. A reset restores each radio's `checked`, but nothing on the reset path applied a radio
 * master's group again: `updateRadio` never runs from `change` (with live check on, a radio's
 * `change.<id>` runs only the live check, which the reset holds off). So after picking the radio a
 * field names and resetting, the radio was unchecked again while its field stayed enabled — sent with
 * the form, and counted by the submit control's gate (gated on a valid form when the field is
 * required). A checkbox master was not affected: its `change.<id>` listener applies its group on a timer.
 *
 * The fix: the bind leaves a hook on the form's record (`applyElementGroups`) that replays the bind's
 * group pass: every radio and every checkbox, in page order. The reset calls it after restoring the
 * values and before its one pass; a master checkbox's timer, which runs after that pass, calls it again
 * before it re-reads the gate. The bind applies the masters in page order, so a field naming a radio
 * and a checkbox follows whichever comes last (#B1082): the reset now lands on that state in either
 * order (09, 10). The first cut of this fix applied only the radios, also on the timer: with the radios
 * first, it left such a field enabled after any reset (09, 12), and a page that removed a field's group
 * attribute after the bind made each reset throw (13). That throw comes from the radio pass, which on
 * develop already threw on a radio pick (14, `null.replace`); the pass now skips such a field.
 *
 * The instrument: a snapshot of every control of the form (checked, disabled, value) and of the
 * submit control's gate, read once the form is bound; after the arm's clicks and the reset, the form
 * must read that same snapshot again. Each arm first asserts that its clicks moved the state, so a
 * snapshot equal to the bound one cannot come from clicks that never landed.
 *
 * RED on: D = develop before this fix, C = the first cut of this fix (both measured on Chromium and WebKit).
 *   01 a field naming a radio; the radio picked, form.reset()             -> as bound            (RED on D)
 *   02 the same, the handle's resetFields()                                -> as bound            (D)
 *   03 a checkbox under a radio master (unticked in the markup) and a
 *      field naming both; radio picked, box ticked, form.reset()           -> as bound            (D)
 *   04 the same with the box ticked in the markup                          -> as bound            (D)
 *   05 a field naming two radios of two groups; both picked, form.reset()  -> as bound            (D)
 *   06 reBind(), then the radio picked, form.reset()                       -> as bound            (D)
 *   07 CONTROL a checkbox master unticked, form.reset(): its required field is back and the gate closes
 *   08 CONTROL no reset: picking the radio enables its field, picking its peer disables it
 *   09 the radios before a checkbox master, a field naming both; a reset of the untouched form, after a
 *      pick, after a tick                                                  -> as bound            (C)
 *   10 the same with the checkbox master before the radios                 -> as bound            (D)
 *   11 a box under a radio master that no field names alone; radio picked,
 *      box ticked, form.reset()                                            -> as bound            (D)
 *   12 arm 09's form with live check off                                   -> as bound            (C)
 *   13 a field's group attribute removed after the bind, the form left
 *      invalid, form.reset()                                               -> no error, as bound  (C)
 *   14 the same attribute removed, a radio picked, then form.reset()       -> no error, as bound  (D and C)
 *   15 a form in a popin; the radio picked, form.reset()                   -> as bound            (D)
 *   16 radios outside the form, reassociated with form=; picked, reset     -> as bound            (D)
 *   17 reBind() after a radio group was added to the form; its radio
 *      picked, form.reset()                                                -> as rebound          (D)
 *   18 CONTROL two checkbox masters, a field naming both; ticks, resets    -> as bound
 * Arm 17 also fails on a bundle whose hook keeps the first bind's controls, while arm 06 passes there
 * (same controls at bind and at the rebind): only 17 can see a stale hook.
 *
 * Pre-fix arm: `GINA_B1040_PREFIX_BUNDLE=<path to a gina.min.js>` serves that bundle instead of the
 * working-tree dist (the plugins subtract recipe).
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

/** `form()` with extra attributes on the `<form>` tag. */
const formWith = (id, attrs, controls) => form(id, controls).replace('<form id="' + id + '"', '<form id="' + id + '" ' + attrs);

// Arms 09, 10, 12, 13 and 14: radios `pm` and `pa` (`pa` checked), a checkbox master `m` (unticked), a field `G`
// naming `m` and a field `F` naming `pa m`. At bind, F follows whichever master comes last in the page
// (#B1082): off with the radios first, on with the box first.
const RADIOS_PA = wrap('<input id="pm" type="radio" name="plan" value="m">') + wrap('<input id="pa" type="radio" name="plan" value="a" checked>');
const BOX_M = wrap('<input id="m" type="checkbox" name="m" value="yes">');
const FIELDS_GF = wrap('<input id="G" type="text" name="G" data-gina-form-element-group="m">') + wrap('<input id="F" type="text" name="F" data-gina-form-element-group="pa m">');
const UNDER_PA = form('grpx', PLAN
    + wrap('<input id="x" type="checkbox" name="x" value="y" data-gina-form-element-group="pa">')
    + wrap('<input id="F2" type="text" name="F2" data-gina-form-element-group="pa">'));
const REASSOC = wrap('<input id="pm" type="radio" name="plan" value="m" form="grpf" checked>') + wrap('<input id="pa" type="radio" name="plan" value="a" form="grpf">')
    + form('grpf', wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="pa">'));
const TWO_BOXES = form('grpm', wrap('<input id="m1" type="checkbox" name="m1" value="y" checked>') + wrap('<input id="m2" type="checkbox" name="m2" value="y">')
    + wrap('<input id="H" type="text" name="H" data-gina-form-element-group="m1 m2">') + wrap('<input id="K" type="text" name="K" data-gina-form-element-group="m2">'));
const POPIN_TRIGGER = '<button data-gina-popin-name="b1040p" data-gina-popin-url="/frag/b1040p.html" data-gina-dialog-preload="false">Open</button>';

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

/**
 * Serves a page holding only a popin trigger, registers the popin `b1040p` with the validator, opens it
 * on `fragHtml` and waits for the form it carries to be bound and its bind-time pass to have settled.
 *
 * @param {object} page
 * @param {string} fragHtml - the popin's content, served at /frag/b1040p.html
 * @param {string} id - the id of the form in that content
 * @returns {Promise<{errors: string[], prefix: number}>}
 */
async function openPopin(page, fragHtml, id) {
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.route('**/frag/b1040p.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fragHtml }));
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1040 popin</title><link rel="icon" href="data:,">'
        + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1040.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + POPIN_TRIGGER + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms), null, { timeout: 15000 });
    const registered = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'b1040p', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(registered, 'the popin registers with the validator').toBe('READY');
    await page.click('[data-gina-popin-name="b1040p"]');
    await page.waitForFunction((fid) => !!(window.gina.validator.$forms[fid] && window.gina.validator.$forms[fid].binded), id, { timeout: 8000 });
    await page.waitForTimeout(600);
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/**
 * Arms 09, 10 and 12: resets the untouched form, then the form after `pm` is picked, then after `m` is
 * ticked, and returns the snapshot at bind, after each step and after each reset.
 *
 * @param {object} page
 * @param {string} id - the form's id
 * @returns {Promise<object>} `{ bound, untouched, picked, afterPick, ticked, afterTick }`
 */
async function resetRounds(page, id) {
    const bound = await snapshot(page, id);
    await reset(page, id, 'form.reset');
    const untouched = await snapshot(page, id);
    await pick(page, '#pm');
    const picked = await snapshot(page, id);
    await reset(page, id, 'form.reset');
    const afterPick = await snapshot(page, id);
    await pick(page, '#m');
    const ticked = await snapshot(page, id);
    await reset(page, id, 'form.reset');
    const afterTick = await snapshot(page, id);
    return { bound, untouched, picked, afterPick, ticked, afterTick };
}

/**
 * Arms 09, 10 and 12: the clicks of `resetRounds` landed, and each reset brought the form back to its
 * state at bind, whatever that state is (in the box-first order it is #B1082's).
 *
 * @param {object} r - what `resetRounds` returned
 * @param {{errors: string[]}} seen
 * @returns {undefined}
 */
function expectRoundsAsBound(r, seen) {
    expect(r.picked.controls.pm, 'the pick landed').toBe('checked enabled');
    expect(r.picked.controls.pa, 'and unchecked its peer').toBe('unchecked enabled');
    expect(r.ticked.controls.m, 'the tick landed').toBe('checked enabled');
    expect(r.ticked.controls.G, 'and enabled the field naming the box alone').toBe('value= enabled');
    expect(r.untouched.controls, 'a reset of the untouched form changes nothing').toEqual(r.bound.controls);
    expect(r.untouched.gated, 'nor the gate').toBe(r.bound.gated);
    expect(r.afterPick.controls, 'the reset after the pick brings every control back to its state at bind').toEqual(r.bound.controls);
    expect(r.afterPick.gated, 'and the gate with it').toBe(r.bound.gated);
    expect(r.afterTick.controls, 'the reset after the tick brings every control back to its state at bind').toEqual(r.bound.controls);
    expect(r.afterTick.gated, 'and the gate with it').toBe(r.bound.gated);
    expect(seen.errors).toEqual([]);
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

    test('09 the radios before a checkbox master, a field naming both: each reset (untouched, after a pick, after a tick) reads as bound', async ({ page }) => {
        const seen = await open(page, form('grpo1', RADIOS_PA + BOX_M + FIELDS_GF), 'grpo1');
        expectRoundsAsBound(await resetRounds(page, 'grpo1'), seen);
    });

    test('10 the checkbox master before the radios, a field naming both: each reset reads as bound', async ({ page }) => {
        const seen = await open(page, form('grpo2', BOX_M + RADIOS_PA + FIELDS_GF), 'grpo2');
        expectRoundsAsBound(await resetRounds(page, 'grpo2'), seen);
    });

    test('11 a checkbox under a radio master that no field names alone; the radio picked, the box ticked, form.reset(): the form reads as bound', async ({ page }) => {
        const seen = await open(page, UNDER_PA, 'grpx');
        const bound = await snapshot(page, 'grpx');
        await pick(page, '#pa');
        await pick(page, '#x');
        const picked = await snapshot(page, 'grpx');
        await reset(page, 'grpx', 'form.reset');
        const after = await snapshot(page, 'grpx');

        expect(bound.controls.x, 'bound: the box follows its unchecked radio').toBe('unchecked disabled');
        expect(bound.controls.F2, 'bound: so does the field').toBe('value= disabled');
        expect(picked.controls.x, 'radio picked, box ticked').toBe('checked enabled');
        expect(picked.controls.F2, 'the field is on, or the arm proves nothing').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('12 arm 09\'s form with live check off: each reset reads as bound', async ({ page }) => {
        const seen = await open(page, formWith('grpl', 'data-gina-form-live-check-enabled="false"', RADIOS_PA + BOX_M + FIELDS_GF), 'grpl');
        expectRoundsAsBound(await resetRounds(page, 'grpl'), seen);
    });

    test('13 a field\'s group attribute removed after the bind, the form left invalid, form.reset(): no error, the form reads as bound', async ({ page }) => {
        const seen = await open(page, form('grpa', RADIOS_PA + BOX_M + FIELDS_GF), 'grpa');
        const bound = await snapshot(page, 'grpa');
        await page.evaluate(() => { document.getElementById('G').removeAttribute('data-gina-form-element-group'); });
        await page.locator('#r3').fill('');
        await page.locator('#r3').press('Tab');
        await page.waitForTimeout(1300);
        const emptied = await snapshot(page, 'grpa');
        await reset(page, 'grpa', 'form.reset');
        const after = await snapshot(page, 'grpa');

        expect(emptied.gated, 'the emptied required field closed the gate, or the arm proves nothing').toBe('true');
        expect(seen.errors, 'the reset throws nothing').toEqual([]);
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and reads the gate again').toBe(bound.gated);
    });

    test('14 a field\'s group attribute removed after the bind, a radio picked: no error', async ({ page }) => {
        const seen = await open(page, form('grpn', RADIOS_PA + BOX_M + FIELDS_GF), 'grpn');
        const bound = await snapshot(page, 'grpn');
        await page.evaluate(() => { document.getElementById('G').removeAttribute('data-gina-form-element-group'); });
        await pick(page, '#pm');
        const picked = await snapshot(page, 'grpn');
        await reset(page, 'grpn', 'form.reset');
        const after = await snapshot(page, 'grpn');

        expect(picked.controls.pm, 'the pick landed').toBe('checked enabled');
        expect(picked.controls.F, 'the field naming the unchecked radio is off').toBe('value= disabled');
        expect(seen.errors, 'neither the pick nor the reset throws').toEqual([]);
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
    });

    test('15 a form in a popin: the radio picked, form.reset(): the form reads as bound', async ({ page }) => {
        const seen = await openPopin(page, '<div id="pp">' + form('grpp', PLAN + wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="pa">')) + '</div>', 'grpp');
        const bound = await snapshot(page, 'grpp');
        await pick(page, '#pa');
        const picked = await snapshot(page, 'grpp');
        await reset(page, 'grpp', 'form.reset');
        const after = await snapshot(page, 'grpp');

        expect(bound.controls.dep, 'bound: the field follows its unchecked radio').toBe('value= disabled');
        expect(picked.controls.dep, 'the pick enabled the field, or the arm proves nothing').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('16 radios outside the form, reassociated with form=: the radio picked, form.reset(): the form reads as bound', async ({ page }) => {
        const seen = await open(page, REASSOC, 'grpf');
        const bound = await snapshot(page, 'grpf');
        await pick(page, '#pa');
        const picked = await snapshot(page, 'grpf');
        await reset(page, 'grpf', 'form.reset');
        const after = await snapshot(page, 'grpf');

        expect(Object.keys(bound.controls), 'the reassociated radios are the form\'s').toEqual(expect.arrayContaining(['pm', 'pa']));
        expect(bound.controls.dep, 'bound: the field follows its unchecked radio').toBe('value= disabled');
        expect(picked.controls.dep, 'the pick enabled the field, or the arm proves nothing').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at bind').toEqual(bound.controls);
        expect(after.gated, 'and the gate with it').toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('17 reBind() after a radio group was added to the form: its radio picked, form.reset(): the form reads as rebound', async ({ page }) => {
        const seen = await open(page, form('grpb', PLAN + wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="pa">')), 'grpb');
        await page.evaluate(() => {
            document.getElementById('dep').parentNode.insertAdjacentHTML('afterend',
                '<div><input id="sm" type="radio" name="ship" value="m" checked></div>'
                + '<div><input id="sa" type="radio" name="ship" value="a"></div>'
                + '<div><input id="sdep" type="text" name="sdep" data-gina-form-element-group="sa"></div>');
            window.gina.validator.$forms.grpb.reBind();
        });
        await page.waitForTimeout(600);
        const rebound = await snapshot(page, 'grpb');
        await pick(page, '#sa');
        const picked = await snapshot(page, 'grpb');
        await reset(page, 'grpb', 'form.reset');
        const after = await snapshot(page, 'grpb');

        expect(rebound.controls.sdep, 'the rebind applied the added radio\'s group, or the arm proves nothing').toBe('value= disabled');
        expect(picked.controls.sdep, 'the pick enabled the added field').toBe('value= enabled');
        expect(after.controls, 'the reset brings every control back to its state at the rebind').toEqual(rebound.controls);
        expect(after.gated, 'and the gate with it').toBe(rebound.gated);
        expect(seen.errors).toEqual([]);
    });

    test('18 CONTROL two checkbox masters, a field naming both: each reset (untouched, after a tick, after an untick) reads as bound', async ({ page }) => {
        const seen = await open(page, TWO_BOXES, 'grpm');
        const bound = await snapshot(page, 'grpm');
        await reset(page, 'grpm', 'form.reset');
        const untouched = await snapshot(page, 'grpm');
        await pick(page, '#m2');
        const ticked = await snapshot(page, 'grpm');
        await reset(page, 'grpm', 'form.reset');
        const afterTick = await snapshot(page, 'grpm');
        await pick(page, '#m1');
        const unticked = await snapshot(page, 'grpm');
        await reset(page, 'grpm', 'form.reset');
        const afterUntick = await snapshot(page, 'grpm');

        expect(ticked.controls.K, 'the tick enabled the field naming the box alone').toBe('value= enabled');
        expect(ticked.controls.H, 'and the field naming both boxes').toBe('value= enabled');
        expect(unticked.controls.m1, 'the untick landed').toBe('unchecked enabled');
        expect(untouched.controls).toEqual(bound.controls);
        expect(afterTick.controls).toEqual(bound.controls);
        expect(afterTick.gated).toBe(bound.gated);
        expect(afterUntick.controls).toEqual(bound.controls);
        expect(afterUntick.gated).toBe(bound.gated);
        expect(seen.errors).toEqual([]);
    });
});
