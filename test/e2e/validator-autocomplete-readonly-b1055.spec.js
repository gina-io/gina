'use strict';

/**
 * Playwright RUNTIME e2e for #B1055, #B1063, #B1064 — on a Safari user agent, a live-checked
 * `<input autocomplete="off">` stays `readonly` until it has focus, and every key stays native.
 *
 * The defects: a keydown handler rebuilt the value by hand while such a field had focus. `email`
 * and `number`, which have no Selection API, typed backwards and posted that way (`123` sent
 * `321`), Tab trapped or skipped, Enter did nothing, `maxlength` was ignored, an authored
 * `readonly` was lifted, no `input` event fired, and a `query` rule sent one request per key.
 *
 * webkit-project-ONLY, but for the last describe: the workaround is gated to REAL Safari UAs
 * (#B135), so on the other engines every arm would pass vacuously. Runs in the on-demand
 * cross-engine job and locally via:
 *
 *   GINA_E2E_ENGINES=all npx playwright test test/e2e/validator-autocomplete-readonly-b1055.spec.js --project=webkit
 *
 * Each page is built through page.route over the fixture's own page, so the real bundle binds
 * the form. Where the browser's own behaviour varies by platform, a plain field on the same
 * engine is the oracle: the expected value is read, never written here. Validated red first:
 * develop's bundle, served at /js/gina.min.js, failed every arm that names a defect above.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { copyBlobBodies, requestBody } = require('./helpers/request-body');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'validator-autocomplete.html'), 'utf8');
const FORM_RE = /<form id="acform"[\s\S]*?<\/form>/;
const STOCK_RULES = JSON.stringify({ rules: { acform: { ref: { isRequired: true } } } });

const wrap = (inner) => '<form id="acform" data-gina-form-rule="acform" data-gina-form-live-check-enabled="true" action="/ac-sink" method="post">'
    + inner + '<button id="acform-submit" type="submit">Submit</button></form><p><input id="outside" type="text" name="outside"></p>';

const OFF = '<input id="a" type="text" name="ref" autocomplete="off">';
const PLAIN = '<input id="a" type="text" name="ref">';
const NEXT = '<input id="d" type="text" name="d">';

/**
 * Opens the fixture with the given form body and waits for the bind.
 *
 * @param {import('@playwright/test').Page} page - the page
 * @param {string} inner - the form's fields
 * @param {object} [rules] - the rule set of `acform`, in place of the stock one
 * @returns {Promise<{errors: string[], queries: number, rewritten: ?boolean}>} what the page did
 */
async function open(page, inner, rules) {
    const seen = { errors: [], queries: 0, rewritten: null };
    page.on('pageerror', (e) => seen.errors.push(String(e && e.message || e)));
    await page.route('**/autocomplete', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE.replace(FORM_RE, wrap(inner)) }));
    if (rules) {
        await page.route('**/js/gina.onload.autocomplete.js', async (route) => {
            const body = await (await route.fetch()).text();
            const from = encodeURIComponent(STOCK_RULES);
            seen.rewritten = body.indexOf(from) > -1;
            await route.fulfill({ status: 200, contentType: 'application/javascript', body: body.split(from).join(encodeURIComponent(JSON.stringify({ rules: { acform: rules } }))) });
        });
        await page.route('**/uniq*', async (r) => { seen.queries++; await r.fulfill({ status: 200, contentType: 'application/json', body: '{"isValid":true}' }); });
    }
    await page.goto(BASE + 'autocomplete');
    await page.waitForFunction(() => window.gina && window.gina.isFrameworkLoaded && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms.acform);
    await page.waitForTimeout(300);
    return seen;
}

const value = (page, id) => page.evaluate((i) => document.getElementById(i).value, id);
const mark = (page, id) => page.evaluate((i) => document.getElementById(i).getAttribute('readonly'), id);
const active = (page) => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
const clickOn = async (page, id) => { await page.click('#' + id); await page.waitForTimeout(120); };
const typeIn = async (page, id, keys) => { await clickOn(page, id); await page.keyboard.type(keys, { delay: 60 }); await page.waitForTimeout(120); };

test.describe('#B1055, #B1063, #B1064 — readonly until focus, native keys (webkit only)', () => {

    test.skip(({ browserName }) => browserName !== 'webkit',
        'the workaround is gated to REAL Safari UAs (#B135); only the webkit project carries one');

    for (const [type, keys] of [['email', 'abc'], ['number', '123'], ['text', 'abc'], ['search', 'abc'], ['url', 'abc'], ['tel', '123'], ['password', 'abc']]) {
        test('01 - type=' + type + ': the keys land in order, with no error', async ({ page }) => {
            const seen = await open(page, '<input id="a" type="' + type + '" name="ref" autocomplete="off">' + NEXT);
            expect(await mark(page, 'a'), 'bound: gina\'s mark').toBe('gina');
            await typeIn(page, 'a', keys);
            expect(await value(page, 'a')).toBe(keys);
            expect(seen.errors, 'no uncaught error').toEqual([]);
            await page.keyboard.press('Tab');
            await page.waitForTimeout(150);
            expect(await active(page), 'Tab leaves the field').toBe('d');
            expect(await mark(page, 'a'), 'the mark is back on blur').toBe('gina');
        });
    }

    for (const [label, input] of [['autocomplete="off"', '<input id="a" type="number" name="ref" autocomplete="off">'], ['plain, the control', '<input id="a" type="number" name="ref">']]) {
        test('02 - the request carries what was typed: ' + label, async ({ page, context }) => {
            await context.addInitScript(copyBlobBodies);
            const bodies = [];
            page.on('request', (r) => { if (/ac-sink/.test(r.url())) { bodies.push((requestBody(r) || Buffer.alloc(0)).toString('utf8')); } });
            await open(page, input);
            await typeIn(page, 'a', '123');
            await page.click('#acform-submit');
            await page.waitForTimeout(1200);
            expect(bodies.length, 'control: one request reached the sink').toBe(1);
            expect(bodies[0]).toContain('123');
            expect(bodies[0]).not.toContain('321');
        });
    }

    const TAB_MIX = (attr) => '<input id="z" type="text" name="z"><input id="a" type="text" name="ref"' + attr + '><input id="p" type="password" name="p"><input id="e" type="email" name="e"><textarea id="t" name="t"></textarea>' + NEXT;
    const TAB_LAST = (attr) => '<input id="z" type="text" name="z"><input id="a" type="text" name="ref"' + attr + '>';
    for (const [label, press, shape] of [['Tab to the next field, a password', 'Tab', TAB_MIX], ['Shift+Tab back', 'Shift+Tab', TAB_MIX], ['Tab from the form\'s last field', 'Tab', TAB_LAST]]) {
        test('03 - ' + label + ': as on a plain field', async ({ page, browser }) => {
            const other = await browser.newPage();
            await open(other, shape(''));
            await clickOn(other, 'a');
            await other.keyboard.press(press);
            await other.waitForTimeout(150);
            const oracle = await active(other);
            await other.close();
            expect(oracle, 'control: the key moved the focus on the plain form').not.toBe('a');

            await open(page, shape(' autocomplete="off"'));
            await clickOn(page, 'a');
            await page.keyboard.press(press);
            await page.waitForTimeout(150);
            expect(await active(page)).toBe(oracle);
        });
    }

    for (const [label, input] of [['autocomplete="off"', '<input id="a" type="text" name="ref" autocomplete="off" value="abcd">'], ['plain, the control', '<input id="a" type="text" name="ref" value="abcd">']]) {
        test('04 - Enter submits: ' + label, async ({ page }) => {
            const sent = [];
            page.on('request', (r) => { if (/ac-sink/.test(r.url())) { sent.push(r.method()); } });
            await open(page, input);
            await clickOn(page, 'a');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1200);
            expect(sent).toEqual(['POST']);
        });
    }

    test('05 - maxlength holds', async ({ page }) => {
        await open(page, '<input id="a" type="text" name="ref" autocomplete="off" maxlength="3">' + NEXT);
        await typeIn(page, 'a', 'abcde');
        expect(await value(page, 'a')).toBe('abc');
    });

    test('06 - input and beforeinput fire once per key', async ({ page }) => {
        await open(page, OFF + NEXT);
        await clickOn(page, 'a');
        await page.evaluate(() => {
            window.__c = { input: 0, beforeinput: 0 };
            document.addEventListener('input', () => window.__c.input++, true);
            document.addEventListener('beforeinput', () => window.__c.beforeinput++, true);
        });
        await page.keyboard.type('abc', { delay: 60 });
        await page.waitForTimeout(120);
        expect(await page.evaluate(() => window.__c)).toEqual({ input: 3, beforeinput: 3 });
    });

    for (const press of ['ArrowUp', 'ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight']) {
        test('07 - ' + press + ': as on a plain field', async ({ page, browser }) => {
            const drive = async (p, attr) => {
                await open(p, '<input id="a" type="text" name="ref" value="abcd"' + attr + '>');
                await clickOn(p, 'a');
                await p.evaluate(() => document.getElementById('a').setSelectionRange(2, 2));
                await p.keyboard.press(press);
                await p.waitForTimeout(120);
                return p.evaluate(() => { const e = document.getElementById('a'); return [e.value, e.selectionStart, e.selectionEnd]; });
            };
            const other = await browser.newPage();
            const oracle = await drive(other, '');
            await other.close();
            expect(oracle.slice(1), 'control: the key moved the caret or the selection').not.toEqual([2, 2]);
            expect(await drive(page, ' autocomplete="off"')).toEqual(oracle);
        });
    }

    test('08 - readonly until focus: at bind, on focus, on blur, on a focus by script', async ({ page }) => {
        await open(page, OFF + NEXT);
        expect(await mark(page, 'a'), 'at bind').toBe('gina');
        expect(await page.evaluate(() => document.getElementById('a').readOnly), 'the browser reads it as readonly').toBe(true);
        await clickOn(page, 'a');
        expect(await mark(page, 'a'), 'on focus').toBeNull();
        await clickOn(page, 'd');
        expect(await mark(page, 'a'), 'on blur').toBe('gina');
        await page.evaluate(() => document.getElementById('a').focus());
        await page.waitForTimeout(120);
        expect(await mark(page, 'a'), 'on a focus by script').toBeNull();
    });

    test('08b - a control reassociated with form= carries the mark and types; a textarea is left alone', async ({ page }) => {
        const seen = await open(page, OFF + '<textarea id="t" name="t" autocomplete="off"></textarea>' + NEXT);
        await page.evaluate(() => {
            const r = document.createElement('input');
            r.id = 'r';
            r.name = 'r';
            r.type = 'text';
            r.setAttribute('autocomplete', 'off');
            r.setAttribute('form', 'acform');
            document.body.appendChild(r);
            window.gina.validator.$forms.acform.reBind();
        });
        await page.waitForTimeout(300);
        expect(await mark(page, 'r'), 'the reassociated control').toBe('gina');
        await typeIn(page, 'r', 'abc');
        expect(await value(page, 'r')).toBe('abc');
        await clickOn(page, 'd');
        expect(await mark(page, 'r'), 'its mark is back on blur').toBe('gina');
        expect(await mark(page, 't'), 'the textarea').toBeNull();
        expect(seen.errors).toEqual([]);
    });

    for (const attr of ['readonly', 'readonly=""', 'readonly="readonly"']) {
        test('09 - ' + attr + ' in the markup stays, a re-bind included', async ({ page }) => {
            await open(page, '<input id="a" type="text" name="ref" autocomplete="off" value="keep" ' + attr + '>' + NEXT);
            const written = await mark(page, 'a');
            expect(written, 'control: the page\'s attribute').not.toBeNull();
            expect(written).not.toBe('gina');
            await typeIn(page, 'a', 'xy');
            expect(await value(page, 'a')).toBe('keep');
            expect(await mark(page, 'a')).toBe(written);
            await page.evaluate(() => window.gina.validator.$forms.acform.reBind());
            await page.waitForTimeout(200);
            await typeIn(page, 'a', 'z');
            expect(await value(page, 'a')).toBe('keep');
            expect(await mark(page, 'a')).toBe(written);
        });
    }

    for (const [label, lock, written] of [['readOnly = true', (e) => { e.readOnly = true; }, ''], ['setAttribute', (e) => { e.setAttribute('readonly', 'readonly'); }, 'readonly']]) {
        test('10 - a lock by script at rest (' + label + ') holds through focus and blur, and an unlock gives the field back', async ({ page }) => {
            await open(page, OFF + NEXT);
            await page.evaluate('(' + lock.toString() + ')(document.getElementById("a"))');
            expect(await mark(page, 'a'), 'control: the lock replaced gina\'s mark').toBe(written);
            await typeIn(page, 'a', 'xy');
            expect(await value(page, 'a')).toBe('');
            await clickOn(page, 'd');
            expect(await mark(page, 'a')).toBe(written);
            await page.evaluate(() => { document.getElementById('a').readOnly = false; });
            await typeIn(page, 'a', 'z');
            expect(await value(page, 'a')).toBe('z');
            await clickOn(page, 'd');
            expect(await mark(page, 'a'), 'gina\'s mark is back').toBe('gina');
        });
    }

    test('11 - a lock by script during focus holds through blur and the next focus', async ({ page }) => {
        await open(page, OFF + NEXT);
        await typeIn(page, 'a', 'a');
        await page.evaluate(() => { document.getElementById('a').readOnly = true; });
        await page.keyboard.type('b', { delay: 60 });
        await page.waitForTimeout(120);
        expect(await value(page, 'a')).toBe('a');
        await clickOn(page, 'd');
        expect(await mark(page, 'a')).toBe('');
        await typeIn(page, 'a', 'c');
        expect(await value(page, 'a')).toBe('a');
    });

    test('12 - a clone of a bound field, given a new id and bound by a re-bind, types', async ({ page }) => {
        await open(page, OFF + NEXT);
        await page.evaluate(() => {
            const o = document.getElementById('a');
            const c = o.cloneNode(true);
            c.id = 'c1';
            c.name = 'c1';
            o.parentNode.insertBefore(c, o.nextSibling);
            window.gina.validator.$forms.acform.reBind();
        });
        await page.waitForTimeout(300);
        expect(await mark(page, 'c1'), 'the clone carries gina\'s mark').toBe('gina');
        await typeIn(page, 'c1', 'xy');
        expect(await value(page, 'c1')).toBe('xy');
        await clickOn(page, 'd');
        expect(await mark(page, 'c1')).toBe('gina');
    });

    test('13 - two re-binds at rest: one key, one character, and the mark comes back', async ({ page }) => {
        await open(page, OFF + NEXT);
        await page.evaluate(() => { const f = window.gina.validator.$forms.acform; f.reBind(); f.reBind(); });
        await page.waitForTimeout(300);
        expect(await mark(page, 'a')).toBe('gina');
        await typeIn(page, 'a', 'abc');
        expect(await value(page, 'a')).toBe('abc');
        await clickOn(page, 'd');
        expect(await mark(page, 'a')).toBe('gina');
    });

    test('14 - required and left empty: the error shows on blur, where a plain field shows none until submit', async ({ page, browser }) => {
        const drive = async (p, input) => {
            await open(p, input + NEXT);
            await clickOn(p, 'a');
            await clickOn(p, 'd');
            await p.waitForTimeout(500);
            return p.evaluate(() => /form-item-error/.test(document.getElementById('a').parentNode.className));
        };
        const other = await browser.newPage();
        expect(await drive(other, PLAIN), 'control: a plain field shows no error on blur').toBe(false);
        await other.close();
        expect(await drive(page, OFF)).toBe(true);
    });

    for (const [label, input] of [['autocomplete="off"', OFF], ['plain, the control', PLAIN]]) {
        test('15 - a query rule sends one request for three keys, none more on blur: ' + label, async ({ page }) => {
            const seen = await open(page, input + NEXT, { ref: { isRequired: true, query: { url: '/uniq', method: 'GET', validIf: true } } });
            expect(seen.rewritten, 'control: the rules rewrite happened').toBe(true);
            await clickOn(page, 'a');
            await page.keyboard.type('abc', { delay: 80 });
            await page.waitForTimeout(1400);
            expect(seen.queries).toBe(1);
            await clickOn(page, 'd');
            await page.waitForTimeout(800);
            expect(seen.queries).toBe(1);
        });
    }
});

test.describe('#B1055 — the other engines', () => {

    test.skip(({ browserName }) => browserName === 'webkit',
        'the webkit project carries a Safari UA');

    test('16 - no readonly, native typing, no change.<id> beyond the native change', async ({ page }) => {
        const seen = await open(page, OFF + NEXT);
        expect(await mark(page, 'a')).toBeNull();
        await page.evaluate(() => {
            window.__n = { native: 0, ns: 0 };
            const e = document.getElementById('a');
            e.addEventListener('change', () => window.__n.native++, true);
            e.addEventListener('change.a', () => window.__n.ns++, true);
        });
        await typeIn(page, 'a', 'abc');
        expect(await value(page, 'a')).toBe('abc');
        await clickOn(page, 'd');
        expect(await page.evaluate(() => window.__n)).toEqual({ native: 1, ns: 1 });
        expect(seen.errors).toEqual([]);
    });
});
