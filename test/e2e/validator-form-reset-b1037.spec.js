'use strict';

/**
 * Playwright RUNTIME e2e for the validator fix #B1037 (the real built gina bundle, real forms, real
 * clicks and keystrokes).
 *
 * A form reset ran the live check: `resetFields` writes each default through the value setter and
 * triggers `change` on every field, so each field ran its live pass. Their guard was commented out,
 * and the flag `handleErrorsDisplay` reads as « catch reset » is one-shot, so only the first paint
 * call was caught. A reset now runs one silent pass: nothing painted, the store cleared, the submit
 * trigger re-read.
 *
 *   01 #B1037 — typed text and textarea, `form.reset()`: no aria write, no live-region write
 *      (RED: the live region is written and stays, `aria-invalid` true then false in one task)
 *   02 #B1037 — the same through a real click on the reset button                       (RED)
 *   03 #B1037 — an untouched empty form, reset                                          (RED)
 *   04 #B1037 — the handle's `resetFields()` alone leaves nothing painted               (RED: every
 *      empty required field stays painted)
 *   05 #B1037 — a required checkbox and radio, untouched, `form.reset()`                (RED: the
 *      error stays, their pass is deferred past the clear)
 *   06 #B1037 — text, select, checkbox and radio changed, `form.reset()`                (RED)
 *   07 #B1037 — the same through `resetFields()`                                        (RED)
 *   08 #B1037 — a bound field removed from the page: `form.reset()` does not throw, the rest is
 *      reset, the live check still runs                                 (RED: uncaught TypeError)
 *   09 #B1037 — an empty select: `form.reset()` does not throw           (RED: uncaught TypeError)
 *   10 #B1037 — a `query` answered VALID after the reset paints nothing                 (RED)
 *   11 #B1037 — a `query` answered INVALID after the reset paints nothing               (RED)
 *   12 #B1037 — a select's `query` answered INVALID after the reset paints nothing      (RED)
 *   12b CONTROL — the same two answers with no reset do paint (arms 11 and 12 can fail)
 *   12c #B1037 — a seeded `query` field answered INVALID after the reset paints nothing, and its
 *       own query still left                                                            (RED)
 *   13 #B1037 — a radio ticked and the form reset in one task: its deferred pass paints nothing, a
 *      later pick still runs the live pass                                               (RED)
 *   14 CONTROL — typing after a reset paints as before (the instrument can fire)
 *   15 CONTROL — fill, reset, the gate closes; fill again, the gate opens and the click posts
 *   16 CONTROL — non-empty defaults: nothing painted, the gate open
 *   17 CONTROL — a script wrote a text field before the bind: `form.reset()` ends on `defaultValue`,
 *      `resetFields()` on the value at bind
 *   18 CONTROL — required booleans on checkboxes, one ticked, `form.reset()`: nothing painted (a
 *      boolean checkbox reads `false`, a value)
 *   19 #B1037 — the same reset from the form's success path, after a real POST          (RED)
 *   20 CONTROL — a reset of one form leaves another form's message and live check working
 *
 * From the review of 2026-10-30 (RED on the arc's first cut unless labelled):
 *
 *   21, 21b #B1037 — a master checkbox ticked, reset: its dependent goes off on a timer, after the
 *      reset's pass; the gate opens and the first click posts
 *   22 #B1037 — a master ticked in the markup, unticked, reset: the required dependent is back, the
 *      gate closes
 *   23, 23b #B1037 — the query field first, or two query fields, clean after the reset: the gate is
 *      re-read and the first click posts (RED before the arc too)
 *   24 #B1037 — the answer to the old value comes back first: the reset's pass waits for its own
 *   24b CONTROL — the restored value's answer comes back first
 *   25, 25b #B1037 — `resetFields()` with live check off, or no rule set: no `query`, the page's native
 *      `disabled` on the trigger stays
 *   25c CONTROL — `form.reset()` with live check off keeps its pass
 *   26, 26b #B1037 — a reset while a request is in flight: the trigger stays locked (26b: RED before
 *      the arc too)
 *   27 CONTROL — `resetFields()` in flight, the restored form invalid: the gate closes and stays closed
 *   28 #B1037 — a submit waiting for its `query`, form.reset(), the answer refuses: nothing painted, no
 *      focus moved, the latch and the loading state released, and a later submit works  (RED before the
 *      arc too)
 *   28b CONTROL — the answer accepts: the request leaves with the values the click asked for
 *   29 #B1037 — a clean verdict on a query field not last, after a reset: `isValidating` is down
 *
 * Instruments, armed right before the action: a synchronous hook on `setAttribute` (a MutationObserver
 * reads `aria-invalid` after the task, so it cannot see a true→false inside one), a MutationObserver on
 * the live region, a `requestAnimationFrame` count of frames showing an error.
 *
 * Scene: inline pages served by the runtime server (`/x76-page?b64=`) with the whisper
 * (`/js/gina.onload.b1037.js`); submits go to /ac-sink, which answers {}.
 *
 * Pre-fix arm: `GINA_B1037_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle to the
 * page instead of the working-tree dist (the RED arms fail there, the controls pass).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B1037_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1037_PREFIX_BUNDLE) : null;

// Same polling kicker as the other x76-page specs: runs onGinaLoaded once the framework is there.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const SETTLE = 800;     // past the bind's own silent pass
const AFTER = 800;      // past a reset's silent pass
const KEYUP = 1400;     // past the 1000 ms keyup timer

const wrap = (inner) => '<div>' + inner + '</div>';

/**
 * A form's closing: a reset button and a submit button named after the form.
 *
 * @param {string} id
 * @returns {string}
 */
function buttons(id) {
    return '<button id="' + id + '-reset" type="reset">Reset</button>'
        + '<button id="' + id + '-submit" type="submit">Save</button></form>';
}

/**
 * A rule-bound form on /ac-sink.
 *
 * @param {string} id - the form id and its rule set
 * @param {string} controls
 * @returns {string}
 */
function form(id, controls) {
    return '<form id="' + id + '" data-gina-form-rule="' + id + '" action="/ac-sink" method="post">' + controls + buttons(id);
}

/** Two required text controls, empty or seeded. */
function textsForm(seed) {
    return form('texts', wrap('<input id="r3" type="text" name="r3"' + (seed ? ' value="seed"' : '') + '>')
        + wrap('<textarea id="t3" name="t3">' + (seed ? 'seedt' : '') + '</textarea>'));
}

/** A required text, select, checkbox and radio group. */
function mixedForm() {
    return form('mixed', wrap('<input id="r3" type="text" name="r3">')
        + wrap('<select id="sel" name="sel"><option value="">-</option><option value="a">a</option></select>')
        + wrap('<input id="chk" type="checkbox" name="chk" value="yes">')
        + wrap('<input id="rad1" type="radio" name="rad" value="1"><input id="rad2" type="radio" name="rad" value="2">'));
}

/** A required text and a required field with a `query` rule. */
function queryForm() {
    return form('query', wrap('<input id="r3" type="text" name="r3">') + wrap('<input id="q3" type="text" name="q3">'));
}

/**
 * Serves the `query` rule's answer after `delay` ms.
 *
 * @param {object} page
 * @param {boolean} isValid
 * @param {number} delay
 * @returns {Promise<{n: number}>} the number of queries answered
 */
async function answerQueries(page, isValid, delay) {
    const count = { n: 0 };
    await page.route('**/uniq*', async (route) => {
        count.n++;
        await new Promise((r) => setTimeout(r, delay));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isValid: isValid }) });
    });
    return count;
}

/** The in-page instruments; they count only once armed. */
function instrument() {
    var fv = window.__b1037 = { armed: false, ariaTrue: 0, liveWrites: [], frames: 0, errFrames: 0 };
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
        if (fv.armed && n == 'aria-invalid' && String(v) == 'true') { fv.ariaTrue++; }
        return sa.apply(this, arguments);
    };
    new MutationObserver(function (records) {
        if (!fv.armed) { return; }
        records.forEach(function (r) {
            var host = r.target.nodeType == 1 ? r.target : r.target.parentNode;
            var region = host && host.closest ? host.closest('[role="status"]') : null;
            if (region) { fv.liveWrites.push(region.textContent); }
        });
    }).observe(document, { subtree: true, childList: true, characterData: true });
    function frame() {
        if (fv.armed) {
            fv.frames++;
            if (document.querySelector('.form-item-error, [aria-invalid="true"]')) { fv.errFrames++; }
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

/**
 * Opens a page holding `body`, counts the POSTs to the sink and the page errors, and waits for `ids`
 * to be bound.
 *
 * @param {object} page
 * @param {string} body
 * @param {Array<string>} ids - the form ids
 * @returns {Promise<{posts: Array<string>, errors: Array<string>}>}
 */
async function open(page, body, ids) {
    let hits = null;
    if (PREFIX_BUNDLE) {
        hits = { n: 0 };
        await page.route('**/js/gina.min.js', (r) => { hits.n++; r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    const out = { posts: [], errors: [] };
    page.on('request', (r) => { if (r.url().indexOf('/ac-sink') > -1 && r.method() === 'POST') { out.posts.push(String(r.postData() || '')); } });
    page.on('pageerror', (e) => { out.errors.push(String(e && e.message)); });
    await page.addInitScript(instrument);
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1037</title><link rel="icon" href="data:,">'
        + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1037.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + body + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html).toString('base64url'));
    await page.waitForFunction((list) => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && list.every((i) => window.gina.validator.$forms[i] && window.gina.validator.$forms[i].binded)), ids, { timeout: 15000 });
    if (hits) { expect(hits.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    await page.waitForTimeout(SETTLE);
    return out;
}

/** Arms the instruments. */
function arm(page) {
    return page.evaluate(() => { window.__b1037.armed = true; });
}

/** Types into both text controls of `textsForm`, past their keyup timers. */
async function typeBoth(page) {
    await page.locator('#r3').click();
    await page.locator('#r3').pressSequentially('abc', { delay: 30 });
    await page.waitForTimeout(KEYUP);
    await page.locator('#t3').click();
    await page.locator('#t3').pressSequentially('def', { delay: 30 });
    await page.waitForTimeout(KEYUP);
}

/** Changes every control of `mixedForm`. */
async function changeMixed(page) {
    await page.locator('#r3').click();
    await page.locator('#r3').pressSequentially('abc', { delay: 30 });
    await page.selectOption('#sel', 'a');
    await page.check('#chk');
    await page.check('#rad1');
    await page.waitForTimeout(KEYUP);
}

/** Blurs whatever holds the focus. */
function blur(page) {
    return page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
}

/**
 * What the instruments and the form read now.
 *
 * @param {object} page
 * @param {string} id - the form id
 * @returns {Promise<object>}
 */
function read(page, id) {
    return page.evaluate((fid) => {
        const fv = window.__b1037, h = window.gina.validator.$forms[fid], f = document.getElementById(fid);
        const trigger = document.getElementById(fid + '-submit');
        return {
            ariaTrue: fv.ariaTrue,
            liveWrites: fv.liveWrites,
            frames: fv.frames,
            errFrames: fv.errFrames,
            errors: h.errors ? Object.keys(h.errors) : [],
            painted: f.querySelectorAll('.form-item-error, .form-item-warning, [aria-invalid="true"], .form-item-error-message').length,
            gated: trigger.getAttribute('data-gina-form-submit-gated'),
            flag: h.isBeingReseted === true
        };
    }, id);
}

/**
 * Nothing was painted or announced since the instruments were armed, and nothing is stored.
 *
 * @param {object} r - `read()`'s result
 * @returns {void}
 */
function expectClean(r) {
    expect(r.frames, 'the frame counter ran').toBeGreaterThan(0);
    expect(r.ariaTrue, 'no aria-invalid="true" written').toBe(0);
    expect(r.liveWrites, 'nothing written to the live region').toEqual([]);
    expect(r.errFrames, 'no frame shows an error').toBe(0);
    expect(r.painted, 'nothing left painted').toBe(0);
    expect(r.errors, 'the store is empty').toEqual([]);
    expect(r.flag, 'the reset flag came down').toBe(false);
}

test.describe('#B1037 — a form reset runs no live check', function () {

    test('01 #B1037 — typed, form.reset(): nothing painted or announced, the gate closed', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        await blur(page);
        await page.waitForTimeout(300);
        await arm(page);
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expectClean(r);
        expect(r.gated, 'empty required fields keep the gate closed').toBe('true');
        expect(await page.inputValue('#r3')).toBe('');
        expect(await page.inputValue('#t3')).toBe('');
        expect(run.errors).toEqual([]);
    });

    test('02 #B1037 — typed, a real click on the reset button: nothing painted or announced', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        await arm(page);
        await page.click('#texts-reset');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expectClean(r);
        expect(r.gated).toBe('true');
        expect(await page.inputValue('#t3')).toBe('');
        expect(run.errors).toEqual([]);
    });

    test('03 #B1037 — an untouched empty form, reset: nothing painted or announced', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await arm(page);
        await page.click('#texts-reset');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expectClean(r);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

    test('04 #B1037 — typed, the handle\'s resetFields() alone: nothing painted, the gate re-read', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        await blur(page);
        await page.waitForTimeout(300);
        await arm(page);
        await page.evaluate(() => { window.gina.validator.$forms['texts'].resetFields(); });
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expectClean(r);
        expect(r.gated, 'the gate closes with the fields emptied').toBe('true');
        expect(await page.inputValue('#r3')).toBe('');
        expect(run.errors).toEqual([]);
    });

    test('05 #B1037 — a required checkbox and radio, untouched, form.reset(): no error stays', async ({ page }) => {
        const run = await open(page, mixedForm(), ['mixed']);
        await arm(page);
        await page.evaluate(() => { document.getElementById('mixed').reset(); });
        await page.waitForTimeout(AFTER);
        expectClean(await read(page, 'mixed'));
        expect(run.errors).toEqual([]);
    });

    for (const [label, action] of [
        ['06', () => { document.getElementById('mixed').reset(); }],
        ['07', () => { window.gina.validator.$forms['mixed'].resetFields(); }]
    ]) {
        test(label + ' #B1037 — text, select, checkbox and radio changed, then ' + (label == '06' ? 'form.reset()' : 'resetFields()') + ': restored, nothing painted', async ({ page }) => {
            const run = await open(page, mixedForm(), ['mixed']);
            await changeMixed(page);
            await blur(page);
            await page.waitForTimeout(300);
            await arm(page);
            await page.evaluate(action);
            await page.waitForTimeout(AFTER);
            const r = await read(page, 'mixed');
            expectClean(r);
            expect(r.gated).toBe('true');
            const values = await page.evaluate(() => ({
                r3: document.getElementById('r3').value, sel: document.getElementById('sel').value,
                chk: document.getElementById('chk').checked, rad1: document.getElementById('rad1').checked
            }));
            expect(values).toEqual({ r3: '', sel: '', chk: false, rad1: false });
            expect(run.errors).toEqual([]);
        });
    }

    test('08 #B1037 — a bound field removed from the page: no throw, the rest reset, the live check still runs', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await page.evaluate(() => { const t = document.getElementById('t3'); t.parentNode.removeChild(t); });
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('abc', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await blur(page);
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        expect(run.errors, 'no uncaught error').toEqual([]);
        expect(await page.inputValue('#r3'), 'the remaining field was reset').toBe('');
        expect((await read(page, 'texts')).flag).toBe(false);
        // a stuck flag would silence this
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('z', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        expect((await read(page, 'texts')).gated, 'the live check ran: the only field left is valid').toBeNull();
    });

    test('09 #B1037 — an empty select: form.reset() does not throw, the rest is reset', async ({ page }) => {
        const run = await open(page, form('texts', wrap('<input id="r3" type="text" name="r3">')
            + wrap('<textarea id="t3" name="t3"></textarea>') + wrap('<select id="empty" name="empty"></select>')), ['texts']);
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('abc', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        expect(run.errors, 'no uncaught error').toEqual([]);
        expect(await page.inputValue('#r3')).toBe('');
        expect((await read(page, 'texts')).flag).toBe(false);
    });

    for (const [label, isValid] of [['10', true], ['11', false]]) {
        test(label + ' #B1037 — typed in a query field, form.reset() while it is on the wire, answered ' + (isValid ? 'VALID' : 'INVALID') + ': nothing painted', async ({ page }) => {
            const queries = await answerQueries(page, isValid, 500);
            const run = await open(page, queryForm(), ['query']);
            await page.locator('#q3').click();
            await page.locator('#q3').pressSequentially('def', { delay: 30 });
            // the query leaves when the 1000 ms keyup timer fires
            await expect.poll(() => queries.n, { timeout: 4000 }).toBeGreaterThan(0);
            const atReset = queries.n;
            await blur(page);
            await arm(page);
            await page.evaluate(() => { document.getElementById('query').reset(); });
            await page.waitForTimeout(1500);
            const r = await read(page, 'query');
            expect(queries.n, 'no query for the emptied field').toBe(atReset);
            expectClean(r);
            expect(r.gated).toBe('true');
            expect(await page.inputValue('#q3')).toBe('');
            expect(run.errors).toEqual([]);
        });
    }

    test('12 #B1037 — a select\'s query on the wire, form.reset(), answered INVALID: nothing painted', async ({ page }) => {
        const queries = await answerQueries(page, false, 500);
        const run = await open(page, form('selq', wrap('<input id="r3" type="text" name="r3" value="seed">')
            + wrap('<select id="sel" name="sel"><option value="">-</option><option value="a">a</option></select>')), ['selq']);
        await page.selectOption('#sel', 'a');
        await expect.poll(() => queries.n, { timeout: 4000 }).toBeGreaterThan(0);
        await arm(page);
        await page.evaluate(() => { document.getElementById('selq').reset(); });
        await page.waitForTimeout(1500);
        expectClean(await read(page, 'selq'));
        expect(await page.inputValue('#sel')).toBe('');
        expect(run.errors).toEqual([]);
    });

    test('12b CONTROL — no reset: an INVALID answer paints the input', async ({ page }) => {
        const queries = await answerQueries(page, false, 200);
        const run = await open(page, queryForm(), ['query']);
        await arm(page);
        await page.locator('#q3').click();
        await page.locator('#q3').pressSequentially('def', { delay: 30 });
        await expect.poll(() => queries.n, { timeout: 4000 }).toBeGreaterThan(0);
        await page.waitForTimeout(700);
        await blur(page);
        await page.waitForTimeout(500);
        const r = await read(page, 'query');
        expect(r.ariaTrue, 'the answer painted').toBeGreaterThan(0);
        expect(r.errors, 'and it is stored').toContain('q3');
        expect(run.errors).toEqual([]);
    });

    test('12b CONTROL — no reset: an INVALID answer paints the select', async ({ page }) => {
        const queries = await answerQueries(page, false, 200);
        const run = await open(page, form('selq', wrap('<input id="r3" type="text" name="r3" value="seed">')
            + wrap('<select id="sel" name="sel"><option value="">-</option><option value="a">a</option></select>')), ['selq']);
        await arm(page);
        await page.selectOption('#sel', 'a');
        await expect.poll(() => queries.n, { timeout: 4000 }).toBeGreaterThan(0);
        await page.waitForTimeout(700);
        const r = await read(page, 'selq');
        expect(r.ariaTrue, 'the answer painted').toBeGreaterThan(0);
        expect(run.errors).toEqual([]);
    });

    test('12c #B1037 — a seeded query field typed over, form.reset(), answered INVALID: its query left, nothing painted', async ({ page }) => {
        const queries = await answerQueries(page, false, 200);
        const run = await open(page, form('query', wrap('<input id="r3" type="text" name="r3" value="seed">')
            + wrap('<input id="q3" type="text" name="q3" value="seedq">')), ['query']);
        await page.waitForTimeout(600);
        await page.locator('#q3').click();
        await page.locator('#q3').pressSequentially('x', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await page.waitForTimeout(400);
        await blur(page);
        await page.waitForTimeout(400);
        await page.evaluate(() => { window.gina.validator.$forms['query'].resetErrorsDisplay(); });
        const atReset = queries.n;
        await arm(page);
        await page.evaluate(() => { document.getElementById('query').reset(); });
        await page.waitForTimeout(1200);
        const r = await read(page, 'query');
        expect(queries.n, 'the reset pass asked about the restored value').toBeGreaterThan(atReset);
        expectClean(r);
        expect(await page.inputValue('#q3')).toBe('seedq');
        expect(run.errors).toEqual([]);
    });

    test('13 #B1037 — a radio ticked and the form reset in one task: its deferred pass paints nothing, a later pick still runs', async ({ page }) => {
        const run = await open(page, form('radonly', wrap('<input id="rad1" type="radio" name="rad" value="1"><input id="rad2" type="radio" name="rad" value="2">')), ['radonly']);
        await arm(page);
        await page.evaluate(() => { document.getElementById('rad1').click(); document.getElementById('radonly').reset(); });
        await page.waitForTimeout(AFTER);
        expect(await page.isChecked('#rad1'), 'the reset restored the radio').toBe(false);
        const r = await read(page, 'radonly');
        expectClean(r);
        expect(r.gated, 'nothing picked: gated').toBe('true');
        // the same radio: its `once` must have come down with the dropped pass
        await page.check('#rad1');
        await page.waitForTimeout(AFTER);
        expect((await read(page, 'radonly')).gated, 'the pick ran the live pass: the gate opens').toBeNull();
        expect(run.errors).toEqual([]);
    });

    test('14 CONTROL — typing after a reset paints as before', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        await blur(page);
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        await arm(page);
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('a', { delay: 30 });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(KEYUP);
        await blur(page);
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expect(r.ariaTrue, 'the instrument can fire').toBeGreaterThan(0);
        expect(r.errFrames).toBeGreaterThan(0);
        expect(r.liveWrites.length).toBeGreaterThan(0);
        expect(run.errors).toEqual([]);
    });

    test('15 CONTROL — fill, reset, the gate closes; fill again, the gate opens and the click posts', async ({ page }) => {
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        expect((await read(page, 'texts')).gated, 'filled: the gate is open').toBeNull();
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        expect((await read(page, 'texts')).gated, 'reset: the gate is closed').toBe('true');
        await typeBoth(page);
        expect((await read(page, 'texts')).gated, 'filled again: the gate is open').toBeNull();
        await page.click('#texts-submit');
        await expect.poll(() => run.posts.length, { timeout: 4000 }).toBe(1);
        expect(JSON.parse(run.posts[0])).toEqual({ r3: 'abc', t3: 'def' });
        expect(run.errors).toEqual([]);
    });

    test('16 CONTROL — non-empty defaults: typed over, reset: nothing painted, the gate open', async ({ page }) => {
        const run = await open(page, textsForm(true), ['texts']);
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('x', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await arm(page);
        await page.click('#texts-reset');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'texts');
        expectClean(r);
        expect(r.gated).toBeNull();
        expect(await page.inputValue('#r3')).toBe('seed');
        expect(await page.inputValue('#t3')).toBe('seedt');
        expect(run.errors).toEqual([]);
    });

    for (const [label, action, expected] of [
        ['form.reset() ends on the defaultValue', () => { document.getElementById('texts').reset(); }, 'attr'],
        ['resetFields() ends on the value at bind', () => { window.gina.validator.$forms['texts'].resetFields(); }, 'atbind']
    ]) {
        test('17 CONTROL — a script wrote a text field before the bind: ' + label, async ({ page }) => {
            const run = await open(page, form('texts', wrap('<input id="r3" type="text" name="r3" value="attr">')
                + wrap('<textarea id="t3" name="t3">t</textarea>'))
                + '<script>document.getElementById(\'r3\').value = \'atbind\';</script>', ['texts']);
            await page.locator('#r3').fill('typed');
            await page.waitForTimeout(300);
            await page.evaluate(action);
            await page.waitForTimeout(AFTER);
            expect(await page.inputValue('#r3')).toBe(expected);
            expect(run.errors).toEqual([]);
        });
    }

    /** Required booleans on checkboxes, one ticked, and a required text. */
    function boolsForm() {
        return form('bools', wrap('<input id="r3" type="text" name="r3">')
            + wrap('<input id="a1" type="checkbox" name="a1" checked>') + wrap('<input id="a2" type="checkbox" name="a2">')
            + wrap('<input id="a3" type="checkbox" name="a3">') + wrap('<input id="a4" type="checkbox" name="a4">'));
    }

    test('18 CONTROL — required booleans on checkboxes, one ticked, form.reset(): no box painted', async ({ page }) => {
        const run = await open(page, boolsForm(), ['bools']);
        await page.check('#a2');
        await page.waitForTimeout(300);
        await arm(page);
        await page.evaluate(() => { document.getElementById('bools').reset(); });
        await page.waitForTimeout(AFTER);
        const painted = await page.evaluate(() => document.querySelectorAll('#bools input[type=checkbox][aria-invalid="true"]').length);
        expect(painted, 'a boolean checkbox reads `false`, a value').toBe(0);
        expect(await page.isChecked('#a1')).toBe(true);
        expect(await page.isChecked('#a2')).toBe(false);
        expect(run.errors).toEqual([]);
    });

    test('19 #B1037 — the same reset from the success path, after a real POST: nothing painted or announced', async ({ page }) => {
        const run = await open(page, boolsForm(), ['bools']);
        await page.evaluate(() => {
            window.__b1037.resets = 0;
            const f = document.getElementById('bools');
            window.gina.validator.$forms['bools'].on('success', function () {
                window.__b1037.resets++;
                window.__b1037.armed = true;
                HTMLFormElement.prototype.reset.call(f);
            });
        });
        await page.locator('#r3').click();
        await page.locator('#r3').pressSequentially('abc', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await page.click('#bools-submit');
        await expect.poll(() => run.posts.length, { timeout: 4000 }).toBe(1);
        await expect.poll(() => page.evaluate(() => window.__b1037.resets), { timeout: 4000 }).toBe(1);
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'bools');
        expect(r.ariaTrue, 'no aria-invalid="true" written').toBe(0);
        expect(r.errFrames, 'no frame shows an error').toBe(0);
        expect(r.painted, 'nothing left painted').toBe(0);
        expect(r.errors, 'the store is empty').toEqual([]);
        expect(await page.inputValue('#r3')).toBe('');
        expect(run.errors).toEqual([]);
    });

    test('20 CONTROL — a reset of one form leaves another form\'s message and live check working', async ({ page }) => {
        const run = await open(page, textsForm(false) + form('others', wrap('<input id="o1" type="text" name="o1" value="seed">')
            + wrap('<input id="o2" type="text" name="o2" value="seed">')), ['texts', 'others']);
        // two errors showing on the other form
        for (const id of ['#o1', '#o2']) {
            await page.locator(id).click();
            await page.locator(id).selectText();
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(KEYUP);
            await blur(page);
            await page.waitForTimeout(300);
        }
        const showing = await read(page, 'others');
        expect(showing.errors.sort(), 'both errors are stored').toEqual(['o1', 'o2']);
        await page.evaluate(() => { document.getElementById('texts').reset(); });
        await page.waitForTimeout(AFTER);
        const after = await read(page, 'others');
        expect(after.errors.sort(), 'the other form keeps its errors').toEqual(['o1', 'o2']);
        expect(after.painted, 'and its messages').toBeGreaterThan(0);
        // fixed one by one: each message goes, then the gate opens
        for (const id of ['#o1', '#o2']) {
            await page.locator(id).click();
            await page.locator(id).pressSequentially('ok', { delay: 30 });
            await page.waitForTimeout(KEYUP);
            await blur(page);
            await page.waitForTimeout(300);
        }
        const fixed = await read(page, 'others');
        expect(fixed.painted, 'no message left').toBe(0);
        expect(fixed.gated, 'the gate opened').toBeNull();
        expect(run.errors).toEqual([]);
    });

    /** A seeded required text, a master checkbox, and a required field that depends on it. */
    function groupForm(isMasterTicked) {
        return form('grp', wrap('<input id="r3" type="text" name="r3" value="seed">')
            + wrap('<input id="m" type="checkbox" name="m"' + (isMasterTicked ? ' checked' : '') + '>')
            + wrap('<input id="dep" type="text" name="dep" data-gina-form-element-group="m">'));
    }

    for (const [label, name, reset] of [
        ['21', 'form.reset()', () => { document.getElementById('grp').reset(); }],
        ['21b', 'resetFields()', () => { window.gina.validator.$forms.grp.resetFields(); }]
    ]) {
        test(label + ' #B1037 — a master checkbox ticked, ' + name + ': its dependent goes off, the gate opens, the first click posts', async ({ page }) => {
            const run = await open(page, groupForm(false), ['grp']);
            await page.locator('#m').click();
            await page.waitForTimeout(500);
            expect((await read(page, 'grp')).gated, 'the required dependent, empty, closed the gate').toBe('true');
            await arm(page);
            await page.evaluate(reset);
            await page.waitForTimeout(AFTER);
            const r = await read(page, 'grp');
            expectClean(r);
            expect(await page.isDisabled('#dep'), 'the dependent is off').toBe(true);
            expect(r.gated, 'the form is valid').toBeNull();
            await page.locator('#grp-submit').click();
            await page.waitForTimeout(AFTER);
            expect(run.posts.length, 'the first click posts').toBe(1);
            expect(run.errors).toEqual([]);
        });
    }

    test('22 #B1037 — a master ticked in the markup, unticked, form.reset(): the required dependent is back, the gate closes', async ({ page }) => {
        const run = await open(page, groupForm(true), ['grp']);
        await page.locator('#m').click();
        await page.waitForTimeout(500);
        expect((await read(page, 'grp')).gated, 'the dependent is off, the form valid').toBeNull();
        await arm(page);
        await page.evaluate(() => { document.getElementById('grp').reset(); });
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'grp');
        expect(await page.isDisabled('#dep'), 'the dependent is back').toBe(false);
        expect(r.gated, 'required and empty').toBe('true');
        expect(r.painted, 'nothing painted').toBe(0);
        expect(run.errors).toEqual([]);
    });

    for (const [label, name, id, extra] of [
        ['23', 'the query field first', 'qfirst', ''],
        ['23b', 'two query fields', 'qq', wrap('<input id="q4" type="text" name="q4" value="seed">')]
    ]) {
        test(label + ' #B1037 — ' + name + ', clean after form.reset(): the gate is re-read, the first click posts', async ({ page }) => {
            await answerQueries(page, true, 100);
            const run = await open(page, form(id, wrap('<input id="q3" type="text" name="q3" value="seed">') + extra
                + wrap('<input id="r3" type="text" name="r3" value="seed">')), [id]);
            await page.locator('#r3').click();
            await page.locator('#r3').selectText();
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(KEYUP);
            await blur(page);
            await page.waitForTimeout(300);
            expect((await read(page, id)).gated, 'the emptied field closed the gate').toBe('true');
            // armed in the task of the reset: the error of the emptied field shows until then
            await page.evaluate((f) => { window.__b1037.armed = true; document.getElementById(f).reset(); }, id);
            await page.waitForTimeout(AFTER);
            const r = await read(page, id);
            expectClean(r);
            expect(r.gated, 'the restored form is valid').toBeNull();
            await page.locator('#' + id + '-submit').click();
            await page.waitForTimeout(AFTER);
            expect(run.posts.length, 'the first click posts').toBe(1);
            expect(run.errors).toEqual([]);
        });
    }

    for (const [label, name, taken, seed] of [
        ['24 #B1037', 'the answer to the old value first', 250, 800],
        ['24b CONTROL', 'the restored value\'s answer first', 800, 100]
    ]) {
        test(label + ' — a refused value on the wire, form.reset(), ' + name + ': the gate opens, the first click posts', async ({ page }) => {
            await page.route('**/uniq*', async (route) => {
                const v = new URL(route.request().url()).searchParams.get('v');
                await new Promise((res) => setTimeout(res, v === 'taken' ? taken : seed));
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isValid: v !== 'taken' }) });
            });
            const run = await open(page, form('qval', wrap('<input id="r3" type="text" name="r3" value="seed">')
                + wrap('<input id="q3" type="text" name="q3" value="seed">')), ['qval']);
            await page.waitForTimeout(1000);
            await page.locator('#q3').click();
            await page.locator('#q3').selectText();
            await page.locator('#q3').pressSequentially('taken', { delay: 10 });
            // past the keyup timer: its query is on the wire
            await page.waitForTimeout(1100);
            await arm(page);
            await page.evaluate(() => { document.getElementById('qval').reset(); });
            await page.waitForTimeout(1500);
            const r = await read(page, 'qval');
            expectClean(r);
            expect(await page.inputValue('#q3')).toBe('seed');
            expect(r.gated, 'the restored form is valid').toBeNull();
            await page.locator('#qval-submit').click();
            await page.waitForTimeout(AFTER);
            expect(run.posts.length, 'the first click posts').toBe(1);
            expect(run.errors).toEqual([]);
        });
    }

    test('25 #B1037 — resetFields() with live check off: no query sent, the page\'s native disabled stays', async ({ page }) => {
        const queries = await answerQueries(page, true, 50);
        const run = await open(page, '<form id="qoff" data-gina-form-rule="qoff" data-gina-form-live-check-enabled="false" action="/ac-sink" method="post">'
            + wrap('<input id="q3" type="text" name="q3" value="seed">') + wrap('<input id="r3" type="text" name="r3" value="seed">') + buttons('qoff'), ['qoff']);
        await page.evaluate(() => { document.getElementById('qoff-submit').disabled = true; document.getElementById('r3').value = 'typed'; });
        const before = queries.n;
        await page.evaluate(() => { window.gina.validator.$forms.qoff.resetFields(); });
        await page.waitForTimeout(AFTER);
        expect(await page.inputValue('#r3'), 'restored').toBe('seed');
        expect(queries.n - before, 'no query').toBe(0);
        expect(await page.isDisabled('#qoff-submit'), 'the page\'s disabled stays').toBe(true);
        expect(run.errors).toEqual([]);
    });

    test('25b #B1037 — resetFields() on a form with no rule set: the page\'s native disabled stays', async ({ page }) => {
        const run = await open(page, '<form id="norule" data-gina-form-target="this" action="/ac-sink" method="post">'
            + wrap('<input id="r3" type="text" name="r3" value="seed">') + wrap('<input id="b1" type="checkbox" name="b1">') + buttons('norule'), ['norule']);
        await page.evaluate(() => { document.getElementById('norule-submit').disabled = true; document.getElementById('r3').value = 'typed'; });
        await page.evaluate(() => { window.gina.validator.$forms.norule.resetFields(); });
        await page.waitForTimeout(AFTER);
        expect(await page.inputValue('#r3'), 'restored').toBe('seed');
        expect(await page.isDisabled('#norule-submit'), 'the page\'s disabled stays').toBe(true);
        expect(run.errors).toEqual([]);
    });

    test('25c CONTROL — form.reset() with live check off keeps its pass', async ({ page }) => {
        const queries = await answerQueries(page, true, 50);
        const run = await open(page, '<form id="qoff" data-gina-form-rule="qoff" data-gina-form-live-check-enabled="false" action="/ac-sink" method="post">'
            + wrap('<input id="q3" type="text" name="q3" value="seed">') + wrap('<input id="r3" type="text" name="r3" value="seed">') + buttons('qoff'), ['qoff']);
        const before = queries.n;
        await page.evaluate(() => { document.getElementById('qoff').reset(); });
        await page.waitForTimeout(AFTER);
        expect(queries.n - before, 'its query left').toBe(1);
        expect(run.errors).toEqual([]);
    });

    for (const [label, name, reset] of [
        ['26', 'resetFields()', () => { window.gina.validator.$forms.texts.resetFields(); }],
        ['26b', 'form.reset()', () => { document.getElementById('texts').reset(); }]
    ]) {
        test(label + ' #B1037 — ' + name + ' while a request is in flight: the trigger stays locked until it settles', async ({ page }) => {
            await page.route('**/ac-sink*', async (route) => {
                await new Promise((res) => setTimeout(res, 800));
                await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            });
            const run = await open(page, textsForm(true), ['texts']);
            await page.locator('#texts-submit').click();
            await page.waitForTimeout(150);
            expect(await page.isDisabled('#texts-submit'), 'locked for the request').toBe(true);
            await page.evaluate(reset);
            await page.waitForTimeout(100);
            expect(await page.isDisabled('#texts-submit'), 'still locked').toBe(true);
            await page.waitForTimeout(1100);
            expect(await page.isDisabled('#texts-submit'), 'released by the settle').toBe(false);
            expect(run.posts.length).toBe(1);
            expect(run.errors).toEqual([]);
        });
    }

    test('27 CONTROL — resetFields() in flight, the restored form invalid: the gate closes and stays closed', async ({ page }) => {
        await page.route('**/ac-sink*', async (route) => {
            await new Promise((res) => setTimeout(res, 800));
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });
        const run = await open(page, textsForm(false), ['texts']);
        await typeBoth(page);
        await blur(page);
        expect((await read(page, 'texts')).gated, 'filled, the gate is open').toBeNull();
        await page.locator('#texts-submit').click();
        await page.waitForTimeout(150);
        await page.evaluate(() => { window.gina.validator.$forms.texts.resetFields(); });
        await page.waitForTimeout(1300);
        const r = await read(page, 'texts');
        expect(r.gated, 'empty and required').toBe('true');
        expect(r.painted, 'nothing painted').toBe(0);
        expect(run.posts.length).toBe(1);
        expect(run.errors).toEqual([]);
    });


    for (const [label, name, isValid] of [
        ['28 #B1037', 'the answer refuses: nothing painted, no focus moved, the submit released', false],
        ['28b CONTROL', 'the answer accepts: the request leaves with the clicked values', true]
    ]) {
        test(label + ' — a submit waiting for its query, form.reset(), ' + name, async ({ page }) => {
            await page.route('**/uniq*', async (route) => {
                const v = new URL(route.request().url()).searchParams.get('v');
                await new Promise((res) => setTimeout(res, 500));
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isValid: (v === 'other') ? isValid : true }) });
            });
            const run = await open(page, form('qval', wrap('<input id="r3" type="text" name="r3" value="seed">')
                + wrap('<input id="q3" type="text" name="q3" value="seed">')), ['qval']);
            await page.waitForTimeout(800);
            await page.locator('#q3').click();
            await page.locator('#q3').selectText();
            await page.locator('#q3').pressSequentially('other', { delay: 5 });
            await page.locator('#qval-submit').click();
            await page.waitForTimeout(80);
            expect(await page.evaluate(() => window.gina.validator.$forms.qval.isSubmitting), 'the submit waits for its verdict').toBe(true);
            await page.evaluate(() => { window.__b1037.armed = true; document.getElementById('qval').reset(); });
            await page.waitForTimeout(1300);
            const r = await read(page, 'qval');
            const state = await page.evaluate(() => {
                const h = window.gina.validator.$forms.qval;
                return { isSubmitting: h.isSubmitting, active: document.activeElement && document.activeElement.id,
                    loading: document.getElementById('qval-submit').getAttribute('data-gina-loading') };
            });
            expect(state.isSubmitting, 'the latch is released').toBeFalsy();
            expect(state.loading, 'the loading state is released').toBe('false');
            expect(await page.inputValue('#q3')).toBe('seed');
            if (isValid) {
                expect(run.posts.length, 'one request').toBe(1);
                expect(JSON.parse(run.posts[0]).q3, 'the value the click asked for').toBe('other');
            } else {
                expectClean(r);
                expect(state.active, 'no focus moved onto a field').not.toBe('q3');
                expect(run.posts.length, 'no request').toBe(0);
                expect(r.gated, 'the restored form is valid').toBeNull();
                await page.locator('#qval-submit').click();
                await page.waitForTimeout(AFTER);
                expect(run.posts.length, 'a later submit works').toBe(1);
            }
            expect(run.errors).toEqual([]);
        });
    }


    test('29 #B1037 — a query on the wire, form.reset(), a clean verdict on a field not last: isValidating is down', async ({ page }) => {
        await answerQueries(page, true, 400);
        const run = await open(page, form('tri', wrap('<input id="r3" type="text" name="r3">')
            + wrap('<input id="q3" type="text" name="q3" value="seedq">') + wrap('<input id="t3" type="text" name="t3" value="seedt">')), ['tri']);
        await page.waitForTimeout(600);
        await page.locator('#q3').click();
        await page.locator('#q3').pressSequentially('x', { delay: 5 });
        await page.waitForTimeout(1100);
        const isValidating = () => page.evaluate(() => window.gina.validator.$forms.tri.isValidating);
        expect(await isValidating(), 'the pass is on its way').toBe(true);
        await page.evaluate(() => { document.getElementById('tri').reset(); });
        await page.waitForTimeout(AFTER);
        expect(await isValidating(), 'its flag is down').toBeFalsy();
        expect((await read(page, 'tri')).painted, 'nothing painted').toBe(0);
        expect(run.errors).toEqual([]);
    });

});
