'use strict';

/**
 * Playwright RUNTIME e2e for #B1069 — a live check, or a `query` answer, that outlives its form
 * must stop without throwing (the real built gina bundle, a real form, real keys and clicks).
 *
 * The defect: `destroy()` unbinds a form's listeners and deletes `instance.$forms[id]`, but a
 * check already on its way kept running. The keyup debounce (1 s) and the deferred radio/checkbox
 * pass (0 ms) reach `processEvent`, which read the record and threw « Cannot set properties of
 * undefined (setting 'isValidating') »; a `query` answer reaches its waiter, a listener on the
 * field that `destroy()` leaves, which read `instance.$forms[formId].resetCount` and threw. With
 * the FIELD moved out of its form (no destroy), `event.target.form` / the waiter's form is null and
 * the same reads threw on `getAttribute`. In a page that reports uncaught errors, each was a
 * spurious error; typing kept working.
 *
 * The fix: one guard at each place — no form, or no record: return. Every case where the record
 * exists is unchanged (the controls).
 *
 * The instruments: `pageerror` collects uncaught errors. Positive evidence that the guarded path
 * RAN, read from what the validator prints before it: the debounce prints `[A][…] keyup …` just
 * before it calls `processEvent`, the radio pass ` changed .... <id>` (main.js `addLiveForInput`) —
 * if either line is ever removed, replace the instrument, do not drop the assertion. The `query`
 * answer is HELD by the route until the arm releases it, so the destroy lands while it is in flight.
 *
 *   01 a keystroke's check pending at destroy()                 -> no error  (RED before the fix)
 *   02 a query answer arriving after destroy()                  -> no error  (RED)
 *   03 a query answer arriving after the field left its form    -> no error  (RED)
 *   04 a radio pick whose form is destroyed in the same dispatch -> no error (RED)
 *   05 a keystroke's check pending when the field leaves its form -> no error (RED on WebKit; on
 *      Chromium the debounce never fires after the move — measured — so there it proves nothing)
 *   06 CONTROL the same keystroke, form in place: the check runs and ends
 *   07 CONTROL destroy() then bind again before the debounce ends: the pending check still runs,
 *      on the new record (an identity check would drop it)
 *   08 CONTROL a query answer, form in place: the pass ends (isValidating true -> false)
 *   09 CONTROL a radio pick, form in place: its pass runs
 *
 * Scene: /autocomplete with its form replaced (page.route) by `a` (name `ref`, the stock rule
 * `isRequired`, no autocomplete attribute, so no Safari path) and a plain `d`; arms 02, 03 and 08
 * swap the rules (the onload whisper, as the #B295 spec does) for a `query` on `ref`; arms 04 and
 * 09 swap in two radios `pick`.
 *
 * Pre-fix arm: `GINA_B1069_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle
 * instead of the working-tree dist (the plugins subtract recipe). Measured on 76caf3551's bytes
 * (2026-11-02): 01, 02, 03 and 04 red on Chromium and WebKit, 05 red on WebKit; 06–09 green.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'validator-autocomplete.html'), 'utf8');
const FORM_RE = /<form id="acform"[\s\S]*?<\/form>/;
const PREFIX_BUNDLE = process.env.GINA_B1069_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1069_PREFIX_BUNDLE) : null;

const FORM_OPEN = '<form id="acform" data-gina-form-rule="acform" data-gina-form-live-check-enabled="true" action="/ac-sink" method="post">';
const FORM_CLOSE = '<button id="acform-submit" type="submit">Submit</button></form>';
const TEXT_FORM = FORM_OPEN + '<input id="a" type="text" name="ref"><input id="d" type="text" name="d">' + FORM_CLOSE;
const RADIO_FORM = FORM_OPEN + '<input id="r1" type="radio" name="pick" value="1"><input id="r2" type="radio" name="pick" value="2">' + FORM_CLOSE;

/** The rules literal the /autocomplete harness ships, URL-encoded into gina.onload.autocomplete.js. */
const STOCK_RULES = '{"rules":{"acform":{"ref":{"isRequired":true}}}}';
/** `validIf: true` + a `{"isValid":true}` body is what the engine compares (see the #B295 spec). */
const QUERY_RULES = JSON.stringify({ rules: { acform: { ref: { isRequired: true, query: { url: '/uniq', method: 'GET', validIf: true } } } } });
const RADIO_RULES = JSON.stringify({ rules: { acform: { pick: { isRequired: true } } } });

/**
 * Serves the scene, optionally swaps the rules and holds the `query` answer, then waits for the
 * validator to have bound the form.
 *
 * @param {object} page
 * @param {object} [opts] - `{ form, rules }`
 * @returns {Promise<object>} live readings: `errors`, `timerLines`, `radioLines`, `q`,
 *   `rulesRewritten`, `release()` (lets the held `query` answer go)
 */
async function open(page, opts) {
    opts = opts || {};
    const seen = { errors: [], timerLines: 0, radioLines: 0, q: 0, rulesRewritten: null, prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    page.on('console', (m) => {
        const t = m.text();
        if (/^\[A\]\[/.test(t)) { seen.timerLines++; }
        if (/^ changed \.\.\.\. /.test(t)) { seen.radioLines++; }
    });
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.route('**/autocomplete', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE.replace(FORM_RE, opts.form || TEXT_FORM) }));
    if (opts.rules) {
        await page.route('**/js/gina.onload.autocomplete.js', async (route) => {
            const body = await (await route.fetch()).text();
            const from = encodeURIComponent(STOCK_RULES);
            seen.rulesRewritten = body.indexOf(from) > -1;
            await route.fulfill({ status: 200, contentType: 'application/javascript', body: seen.rulesRewritten ? body.split(from).join(encodeURIComponent(opts.rules)) : body });
        });
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        seen.release = release;
        await page.route('**/uniq*', async (r) => { seen.q++; await held; await r.fulfill({ status: 200, contentType: 'application/json', body: '{"isValid":true}' }); });
    }
    await page.goto(BASE + 'autocomplete');
    await page.waitForFunction(() => !!(
        window.gina
        && window.gina.isFrameworkLoaded
        && window.gina.validator
        && window.gina.validator.$forms
        && window.gina.validator.$forms.acform
    ), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    if (opts.rules) { expect(seen.rulesRewritten, 'the rules anchor must still match, or the scene runs the stock rules').toBe(true); }
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/** Focus a field, then type with a person's pace. */
async function typeIn(page, id, s) {
    await page.click('#' + id);
    await page.waitForTimeout(400);
    await page.keyboard.type(s, { delay: 120 });
    await page.waitForTimeout(150);
}

/** `isValidating` of the form's record, or the string 'gone'. */
function recordState(page) {
    return page.evaluate(() => {
        const f = window.gina.validator.$forms.acform;
        return f ? f.isValidating : 'gone';
    });
}

/** Waits until the held `query` request has reached the route. */
async function queryInFlight(seen) {
    await expect.poll(() => seen.q, { message: 'the query must be in flight, or the arm proves nothing', timeout: 8000 }).toBeGreaterThan(0);
}

/** Moves a field out of its form, into the body. */
function moveOut(page, id) {
    return page.evaluate((i) => { document.body.appendChild(document.getElementById(i)); return document.getElementById(i).form; }, id);
}

test.describe('#B1069 — a check that outlives its form stops without throwing', function () {

    test('01 - a keystroke\'s check pending at destroy() does not throw', async ({ page }) => {
        const seen = await open(page);
        await typeIn(page, 'a', 'x');
        await page.evaluate(() => { window.gina.validator.$forms.acform.destroy(); });
        await page.waitForTimeout(1500);
        expect(await recordState(page), 'the record is gone').toBe('gone');
        expect(seen.timerLines, 'the debounce fired: the guarded path ran').toBeGreaterThan(0);
        expect(seen.errors).toEqual([]);
    });

    test('02 - a query answer arriving after destroy() does not throw', async ({ page }) => {
        const seen = await open(page, { rules: QUERY_RULES });
        await typeIn(page, 'a', 'x');
        await queryInFlight(seen);
        await page.evaluate(() => { window.gina.validator.$forms.acform.destroy(); });
        seen.release();
        await page.waitForTimeout(1200);
        expect(await recordState(page), 'the record is gone').toBe('gone');
        expect(seen.errors).toEqual([]);
    });

    test('03 - a query answer arriving after the field left its form does not throw', async ({ page }) => {
        const seen = await open(page, { rules: QUERY_RULES });
        await typeIn(page, 'a', 'x');
        await queryInFlight(seen);
        expect(await moveOut(page, 'a'), 'the field has no form any more').toBe(null);
        seen.release();
        await page.waitForTimeout(1200);
        expect(seen.errors).toEqual([]);
    });

    test('04 - a radio pick whose form is destroyed in the same dispatch does not throw', async ({ page }) => {
        const seen = await open(page, { rules: RADIO_RULES, form: RADIO_FORM });
        // a listener on gina's own event, added after gina's: it runs after gina's handler, in the
        // same dispatch, before the deferred pass (the native `change` stops at the form's proxy)
        await page.evaluate(() => {
            window.__destroyedInDispatch = 0;
            document.getElementById('r1').addEventListener('change.r1', () => {
                if (window.gina.validator.$forms.acform) { window.gina.validator.$forms.acform.destroy(); window.__destroyedInDispatch++; }
            });
        });
        await page.click('#r1');
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => window.__destroyedInDispatch), 'the form was destroyed inside the pick').toBe(1);
        expect(seen.radioLines, 'the deferred pass ran: the guarded path ran').toBeGreaterThan(0);
        expect(seen.errors).toEqual([]);
    });

    test('05 - a keystroke\'s check pending when the field leaves its form does not throw', async ({ page, browserName }) => {
        const seen = await open(page);
        await typeIn(page, 'a', 'x');
        expect(await moveOut(page, 'a'), 'the field has no form any more').toBe(null);
        await page.waitForTimeout(1500);
        // on Chromium the debounce does not fire after the move (measured), so this arm only
        // discriminates where it does; the reading is printed either way
        console.log('[#B1069 05] ' + browserName + ' debounce fired: ' + seen.timerLines);
        expect(seen.errors).toEqual([]);
    });

    test('06 - CONTROL: the same keystroke with the form in place runs its check', async ({ page }) => {
        const seen = await open(page);
        expect(await recordState(page), 'no pass yet').toBe(null);
        await typeIn(page, 'a', 'x');
        await page.waitForTimeout(1500);
        expect(seen.timerLines, 'the debounce fired').toBeGreaterThan(0);
        expect(await recordState(page), 'the pass ran and ended').toBe(false);
        expect(seen.errors).toEqual([]);
    });

    test('07 - CONTROL: destroy() then bind again before the debounce ends: the check still runs', async ({ page }) => {
        const seen = await open(page);
        await typeIn(page, 'a', 'x');
        await page.evaluate(() => { window.gina.validator.$forms.acform.destroy(); window.gina.validator.validateFormById('acform'); });
        expect(await recordState(page), 'a new record, no pass on it yet').toBe(null);
        await page.waitForTimeout(1500);
        expect(seen.timerLines, 'the debounce fired').toBeGreaterThan(0);
        expect(await recordState(page), 'the pending check ran on the new record').toBe(false);
        expect(seen.errors).toEqual([]);
    });

    test('08 - CONTROL: a query answer with the form in place ends the pass', async ({ page }) => {
        const seen = await open(page, { rules: QUERY_RULES });
        await typeIn(page, 'a', 'x');
        await queryInFlight(seen);
        expect(await recordState(page), 'the pass waits for the answer').toBe(true);
        seen.release();
        await page.waitForTimeout(1200);
        expect(await recordState(page), 'the answer ended the pass').toBe(false);
        expect(seen.errors).toEqual([]);
    });

    test('09 - CONTROL: a radio pick with the form in place runs its pass', async ({ page }) => {
        const seen = await open(page, { rules: RADIO_RULES, form: RADIO_FORM });
        await page.click('#r1');
        await page.waitForTimeout(800);
        expect(seen.radioLines, 'the deferred pass ran').toBeGreaterThan(0);
        expect(await recordState(page), 'and ended').toBe(false);
        expect(seen.errors).toEqual([]);
    });
});
