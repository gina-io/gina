'use strict';

/**
 * Playwright RUNTIME e2e for #B1038 — a select's live pass must not write a page global named `once`
 * (the real built gina bundle, a real form, a real select change).
 *
 * The defect: `updateSelect`'s whole-form callback ended with `once = false;`, and no `once` is in
 * scope there (the `var once` of the live check lives in `addLiveForInput`), so the assignment wrote
 * `window.once`: a page variable of that name was overwritten with `false`, and a page that had none
 * got one. The line had no reader in `updateSelect`.
 *
 * The fix: the line is gone. Nothing else in the callback changes.
 *
 * The instruments: the page's `window.once` before and after the change, and the submit control's
 * gate, which the same callback writes just before that line, as positive evidence that the
 * callback ran (`s1` and `r3` are both required, `r3` is seeded, so picking a value in `s1` opens
 * the gate).
 *
 *   01 a page's `window.once`, then a select change: kept, and the gate opened   (RED before the fix)
 *   02 a page with no `once`, then a select change: still none, the gate opened  (RED)
 *   03 CONTROL a page's `window.once`, no select change: kept
 *
 * Pre-fix arm: `GINA_B1038_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle
 * instead of the working-tree dist (the plugins subtract recipe).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PREFIX_BUNDLE = process.env.GINA_B1038_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1038_PREFIX_BUNDLE) : null;

/** Calls `onGinaLoaded` once the loader and the bundle are both in, as the other /x76-page specs do. */
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const SELECT_FORM = '<form id="sel" data-gina-form-rule="sel" action="/ac-sink" method="post">'
    + '<div><select id="s1" name="s1"><option value="">-</option><option value="a">a</option></select></div>'
    + '<div><input id="r3" type="text" name="r3" value="seed"></div>'
    + '<button id="sel-submit" type="submit">Save</button></form>';

/**
 * Serves the page through /x76-page, optionally setting `window.once` first, and waits for the form
 * to be bound and its bind-time pass to have settled.
 *
 * @param {object} page
 * @param {object} [opts] - `{ once }`: a value the page sets on `window.once` before the bundle loads
 * @returns {Promise<{errors: string[], prefix: number}>} uncaught errors, and how many times the
 *   pre-fix bundle was served
 */
async function open(page, opts) {
    opts = opts || {};
    const seen = { errors: [], prefix: 0 };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e).slice(0, 160)));
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    const pageScript = ( typeof(opts.once) != 'undefined' ) ? '<script>window.once = ' + JSON.stringify(opts.once) + ';</script>' : '';
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1038</title><link rel="icon" href="data:,">'
        + pageScript
        + '<script src="/js/gina.onload.b1038.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + SELECT_FORM + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await page.waitForFunction(() => !!(
        window.gina
        && window.gina.isFrameworkLoaded === true
        && window.gina.validator
        && window.gina.validator.$forms
        && window.gina.validator.$forms.sel
        && window.gina.validator.$forms.sel.binded
    ), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return seen;
}

/** The submit control's gate mark: 'true' while gated. */
const gateOf = (page) => page.evaluate(() => document.getElementById('sel-submit').getAttribute('data-gina-form-submit-gated'));

/** `window.once` as a string, or 'absent' when the page has no such global. */
const onceOf = (page) => page.evaluate(() => ( Object.prototype.hasOwnProperty.call(window, 'once') ? String(window.once) : 'absent' ));

test.describe('#B1038 — a select change writes no page global', () => {

    test('01 a page\'s window.once, then a select change: kept, and the gate opened', async ({ page }) => {
        const seen = await open(page, { once: 'page-value' });
        const gatedBefore = await gateOf(page);
        expect(await onceOf(page), 'the page set it').toBe('page-value');
        await page.selectOption('#s1', 'a');
        await expect.poll(() => gateOf(page), { message: 'the select\'s whole-form callback must run, or the arm proves nothing', timeout: 5000 }).not.toBe('true');
        await page.waitForTimeout(300);

        expect(gatedBefore, 'gated before the change: `s1` is required and empty').toBe('true');
        expect(await onceOf(page), 'the page\'s own value survives the select\'s pass').toBe('page-value');
        expect(seen.errors).toEqual([]);
    });

    test('02 a page with no `once`, then a select change: still none, and the gate opened', async ({ page }) => {
        const seen = await open(page);
        expect(await onceOf(page), 'no such global before the change').toBe('absent');
        await page.selectOption('#s1', 'a');
        await expect.poll(() => gateOf(page), { message: 'the select\'s whole-form callback must run, or the arm proves nothing', timeout: 5000 }).not.toBe('true');
        await page.waitForTimeout(300);

        expect(await onceOf(page), 'the select\'s pass creates no global').toBe('absent');
        expect(seen.errors).toEqual([]);
    });

    test('03 CONTROL a page\'s window.once, no select change: kept', async ({ page }) => {
        const seen = await open(page, { once: 'page-value' });
        await page.waitForTimeout(800);

        expect(await gateOf(page), 'nothing moved the gate').toBe('true');
        expect(await onceOf(page)).toBe('page-value');
        expect(seen.errors).toEqual([]);
    });
});
