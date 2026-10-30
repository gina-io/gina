'use strict';

/**
 * Playwright RUNTIME e2e for the validator fix #B1036 (the real built gina bundle, real forms, real
 * clicks).
 *
 * Two forms sharing a field id: `gina.events['registered.<id>']` is global and keyed by the id, so the
 * second control gets no value setter and no live listener, and nothing said so; `resetFields` looked
 * each field up with `getElementById`, so the second form's reset wrote to the FIRST form's field and
 * painted its error. Duplicate ids are invalid HTML, so the second control's live check stays off: the
 * bind now warns about it once, and a reset works on the form's own controls.
 *
 *   01 #B1036 — the second form's `resetFields()`: its own field restored, the first form's left alone
 *      (RED: it empties the first form's field and paints its error)
 *   02 #B1036 — a real click on the second form's reset button: the same               (RED)
 *   03 #B1036 — one warning at bind, naming the form and the id                        (RED: none)
 *   04 #B1036 — an element that is not a control holds the id first in the page: the form's own
 *      field is restored                                                  (RED: nothing restored)
 *   05 #B1036 — the second form's control sits outside it (`form="…"`), its id shared: restored,
 *      and the first form's field left alone                                           (RED)
 *   06 CONTROL — unique ids: no warning, also after `reBind()` on both forms; each reset restores its own
 *   07 CONTROL — shared ids: the FIRST form's reset restores its own field and its live check still runs
 *
 * Scene: inline pages served by the runtime server (`/x76-page?b64=`) with the whisper
 * (`/js/gina.onload.b1036.js`); submits go to /ac-sink, which answers {}.
 *
 * Pre-fix arm: `GINA_B1036_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle to the
 * page instead of the working-tree dist (the RED arms fail there, the controls pass).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B1036_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1036_PREFIX_BUNDLE) : null;

// Same polling kicker as the other x76-page specs: runs onGinaLoaded once the framework is there.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const SETTLE = 800;     // past the bind's own silent pass
const AFTER = 800;      // past a reset's silent pass
const KEYUP = 1400;     // past the 1000 ms keyup timer

/**
 * A form with one required text control.
 *
 * @param {string} id - the form id and its rule set
 * @param {string} fieldId
 * @param {string} [value]
 * @returns {string}
 */
function oneField(id, fieldId, value) {
    return '<form id="' + id + '" data-gina-form-rule="' + id + '" action="/ac-sink" method="post"><div>'
        + '<input id="' + fieldId + '" type="text" name="ref"' + (value ? ' value="' + value + '"' : '') + '></div>'
        + '<button id="' + id + '-reset" type="reset">Reset</button>'
        + '<button id="' + id + '-submit" type="submit">Save</button></form>';
}

/**
 * Opens a page holding `body`, records the page errors and the console warnings, and waits for `ids`
 * to be bound.
 *
 * @param {object} page
 * @param {string} body
 * @param {Array<string>} ids - the form ids
 * @returns {Promise<{errors: Array<string>, warnings: Array<string>}>}
 */
async function open(page, body, ids) {
    let hits = null;
    if (PREFIX_BUNDLE) {
        hits = { n: 0 };
        await page.route('**/js/gina.min.js', (r) => { hits.n++; r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    const out = { errors: [], warnings: [] };
    page.on('pageerror', (e) => { out.errors.push(String(e && e.message)); });
    page.on('console', (m) => { if (m.type() === 'warning') { out.warnings.push(m.text()); } });
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1036</title><link rel="icon" href="data:,">'
        + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1036.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>' + body + '</body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html).toString('base64url'));
    await page.waitForFunction((list) => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && list.every((i) => window.gina.validator.$forms[i] && window.gina.validator.$forms[i].binded)), ids, { timeout: 15000 });
    if (hits) { expect(hits.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    await page.waitForTimeout(SETTLE);
    return out;
}

/** The warnings naming a shared id. */
function sharedIdWarnings(run) {
    return run.warnings.filter((w) => /is used more than once in this page/.test(w));
}

/** The value of a form's own `ref` control, and whether it is painted. */
function field(page, formId) {
    return page.evaluate((fid) => {
        const f = document.getElementById(fid);
        const el = Array.prototype.filter.call(f.elements, (e) => e.name === 'ref')[0];
        return { value: el.value, aria: el.getAttribute('aria-invalid'), wrapper: el.parentNode.className };
    }, formId);
}

/** Writes each form's own `ref` control with the native setter, so no live pass runs. */
function seed(page, values) {
    return page.evaluate((map) => {
        const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        Object.keys(map).forEach((fid) => {
            const el = Array.prototype.filter.call(document.getElementById(fid).elements, (e) => e.name === 'ref')[0];
            native.call(el, map[fid]);
        });
    }, values);
}

test.describe('#B1036 — two forms that share a field id', function () {

    test('01 #B1036 — the second form\'s resetFields(): its own field restored, the first form\'s left alone', async ({ page }) => {
        const run = await open(page, oneField('fa', 'shared') + oneField('fb', 'shared'), ['fa', 'fb']);
        await seed(page, { fa: 'in-first', fb: 'in-second' });
        await page.evaluate(() => { window.gina.validator.$forms['fb'].resetFields(); });
        await page.waitForTimeout(AFTER);
        const a = await field(page, 'fa'), b = await field(page, 'fb');
        expect(b.value, 'its own field is restored').toBe('');
        expect(a.value, 'the first form\'s field is left alone').toBe('in-first');
        expect(a.aria, 'and not painted').toBeNull();
        expect(run.errors).toEqual([]);
    });

    test('02 #B1036 — a real click on the second form\'s reset button: the same', async ({ page }) => {
        const run = await open(page, oneField('fa', 'shared') + oneField('fb', 'shared'), ['fa', 'fb']);
        await seed(page, { fa: 'in-first', fb: 'in-second' });
        await page.click('#fb-reset');
        await page.waitForTimeout(AFTER);
        const a = await field(page, 'fa'), b = await field(page, 'fb');
        expect(b.value).toBe('');
        expect(a.value).toBe('in-first');
        expect(a.aria).toBeNull();
        expect(a.wrapper, 'no error on the first form').not.toMatch(/form-item-(error|warning)/);
        expect(run.errors).toEqual([]);
    });

    test('03 #B1036 — one warning at bind, naming the form and the id', async ({ page }) => {
        const run = await open(page, oneField('fa', 'shared') + oneField('fb', 'shared'), ['fa', 'fb']);
        const w = sharedIdWarnings(run);
        expect(w.length, 'one warning').toBe(1);
        expect(w[0]).toContain('#fb');
        expect(w[0]).toContain('`shared`');
    });

    test('04 #B1036 — an element that is not a control holds the id first in the page: the form\'s own field is restored', async ({ page }) => {
        const run = await open(page, '<div id="shared">not a control</div>' + oneField('fa', 'shared', 'seed'), ['fa']);
        await page.locator('#fa input[name="ref"]').fill('typed');
        await page.evaluate(() => { window.gina.validator.$forms['fa'].resetFields(); });
        await page.waitForTimeout(AFTER);
        expect((await field(page, 'fa')).value).toBe('seed');
        expect(run.errors).toEqual([]);
    });

    test('05 #B1036 — the second form\'s control sits outside it, its id shared: restored, the first form\'s left alone', async ({ page }) => {
        const outside = '<form id="fb" data-gina-form-rule="fb" action="/ac-sink" method="post">'
            + '<button id="fb-reset" type="reset">Reset</button><button id="fb-submit" type="submit">Save</button></form>'
            + '<div><input id="shared" form="fb" type="text" name="ref"></div>';
        const run = await open(page, oneField('fa', 'shared') + outside, ['fa', 'fb']);
        await seed(page, { fa: 'in-first', fb: 'in-second' });
        await page.click('#fb-reset');
        await page.waitForTimeout(AFTER);
        expect((await field(page, 'fb')).value, 'the reassociated control is restored').toBe('');
        expect((await field(page, 'fa')).value).toBe('in-first');
        expect(run.errors).toEqual([]);
    });

    test('06 CONTROL — unique ids: no warning, also after reBind() on both forms; each reset restores its own', async ({ page }) => {
        const run = await open(page, oneField('fa', 'a-ref') + oneField('fb', 'b-ref'), ['fa', 'fb']);
        await page.evaluate(() => { window.gina.validator.$forms['fa'].reBind(); window.gina.validator.$forms['fb'].reBind(); });
        await page.waitForTimeout(AFTER);
        expect(sharedIdWarnings(run)).toEqual([]);
        await seed(page, { fa: 'in-first', fb: 'in-second' });
        await page.evaluate(() => { window.gina.validator.$forms['fb'].resetFields(); });
        await page.waitForTimeout(AFTER);
        expect((await field(page, 'fb')).value).toBe('');
        expect((await field(page, 'fa')).value).toBe('in-first');
        expect(run.errors).toEqual([]);
    });

    test('07 CONTROL — shared ids: the first form\'s reset restores its own field and its live check still runs', async ({ page }) => {
        const run = await open(page, oneField('fa', 'shared') + oneField('fb', 'shared'), ['fa', 'fb']);
        await seed(page, { fa: 'in-first', fb: 'in-second' });
        await page.click('#fa-reset');
        await page.waitForTimeout(AFTER);
        expect((await field(page, 'fa')).value).toBe('');
        expect((await field(page, 'fb')).value).toBe('in-second');
        await page.locator('#fa input[name="ref"]').click();
        await page.locator('#fa input[name="ref"]').pressSequentially('abc', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        const gated = await page.evaluate(() => document.getElementById('fa-submit').getAttribute('data-gina-form-submit-gated'));
        expect(gated, 'the live check opened the gate').toBeNull();
        expect(run.errors).toEqual([]);
    });
});
