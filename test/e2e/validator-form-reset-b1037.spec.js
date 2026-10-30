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
});
