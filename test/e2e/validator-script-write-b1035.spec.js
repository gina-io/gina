'use strict';

/**
 * Playwright RUNTIME e2e for the validator fix #B1035 (the real built gina bundle, real forms, real
 * clicks and keystrokes).
 *
 * A script's `el.value = …` ran the live check as a user's change would, and painted: the value setter
 * dispatches `change.<id>`, so a field nobody touched showed its error and the live region announced it.
 * Such a write still re-checks the form and updates the gate and the store; it paints nothing new. A
 * message already showing may change or clear, and a real `change` dispatched after the write paints.
 *
 *   01 #B1035 — a required text emptied by a script: nothing painted or announced; the gate closes and
 *      the store holds it                                                 (RED: painted and announced)
 *   02 #B1035 — an invalid non-empty write: the same                                     (RED)
 *   03 #B1035 — a required hidden field emptied: the same                                (RED)
 *   04 #B1035 — emptied while it holds the focus: not even the soft warning              (RED)
 *   05 #B1035 — a field with a `form-item-wrapper`: the same                             (RED)
 *   06 #B1035 — a field with a `query` rule, written a value the answer refuses: nothing painted;
 *      the gate closes                                                                   (RED)
 *   07 #B1035 — a script empties a field, the user works on ANOTHER field: the first stays quiet (RED)
 *   08 CONTROL — a real `change` dispatched after the write paints
 *   09 CONTROL — a keyboard clear and a blur paint
 *   10 CONTROL — the user then touches that field: it paints
 *   11 CONTROL — a click on the gated trigger reveals the error the write left in the store
 *   12 CONTROL — an error showing from a touch, a valid write: the message clears
 *   13 CONTROL — an error showing from a touch, a write that is still invalid: the message changes
 *   13b CONTROL — the same on a field with a `form-item-wrapper`, whose box holds the classes
 *   14 CONTROL — a value written into an empty required field opens the gate
 *   15 #B1035 — written back to its default: nothing painted, the gate open              (RED)
 *   16 CONTROL — a valid write paints nothing, the gate stays open
 *   17 CONTROL — `autocomplete="off"`: a keyboard clear and a blur paint (the path that rewrites the
 *      value through the setter on Safari and WebKit)
 *   18 CONTROL — a `tel` input and a textarea have no value setter: a write re-checks nothing, and a
 *      `change` dispatched after it does
 *   19 #B1035 — a user's pick on a boolean radio, refused by its rule, paints: the framework writes
 *      that value through the setter on the click, and it is no script's write   (RED on the arc's first
 *      cut: the review of 2026-10-30)
 *   19b #B1035 — the same through a `<label for>`
 *   20 CONTROL — a value radio, refused by its rule, paints
 *
 * Instruments, armed right before the action: a synchronous hook on `setAttribute`, a MutationObserver
 * on the live region, a `requestAnimationFrame` count of frames showing an error.
 *
 * Scene: inline pages served by the runtime server (`/x76-page?b64=`) with the whisper
 * (`/js/gina.onload.b1035.js`); submits go to /ac-sink, which answers {}.
 *
 * Pre-fix arm: `GINA_B1035_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle to the
 * page instead of the working-tree dist (the RED arms fail there, the controls pass).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B1035_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1035_PREFIX_BUNDLE) : null;

// Same polling kicker as the other x76-page specs: runs onGinaLoaded once the framework is there.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const SETTLE = 800;     // past the bind's own silent pass
const AFTER = 800;      // past a write's passes
const KEYUP = 1400;     // past the 1000 ms keyup timer

const wrap = (inner) => '<div>' + inner + '</div>';

/**
 * A rule-bound form on /ac-sink, with its submit button.
 *
 * @param {string} id - the form id and its rule set
 * @param {string} controls
 * @returns {string}
 */
function form(id, controls) {
    return '<form id="' + id + '" data-gina-form-rule="' + id + '" action="/ac-sink" method="post">' + controls
        + '<button id="' + id + '-submit" type="submit">Save</button></form>';
}

/** Seeded required controls: a text, another text, an email-checked text, a hidden. */
function seeded() {
    return form('seeded', wrap('<input id="req" type="text" name="req" value="seed">')
        + wrap('<input id="keep" type="text" name="keep" value="seed2">')
        + wrap('<input id="mail" type="text" name="mail" value="a@b.co">')
        + wrap('<input id="hid" type="hidden" name="hid" value="seedh">'));
}

/** An empty required text and a seeded one. */
function emptyOne() {
    return form('emptyone', wrap('<input id="req" type="text" name="req">')
        + wrap('<input id="keep" type="text" name="keep" value="seed2">'));
}

/**
 * Serves the `query` rule's answer.
 *
 * @param {object} page
 * @param {boolean} isValid
 * @returns {Promise<{n: number}>} the number of queries answered
 */
async function answerQueries(page, isValid) {
    const count = { n: 0 };
    await page.route('**/uniq*', async (route) => {
        count.n++;
        await new Promise((r) => setTimeout(r, 200));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isValid: isValid }) });
    });
    return count;
}

/** The in-page instruments; they count only once armed. */
function instrument() {
    var fv = window.__b1035 = { armed: false, ariaTrue: 0, liveWrites: [], frames: 0, errFrames: 0 };
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
            if (document.querySelector('.form-item-error, .form-item-warning, [aria-invalid="true"]')) { fv.errFrames++; }
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

/**
 * Opens a page holding `body`, counts the POSTs and the page errors, and waits for `ids` to be bound.
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
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1035</title><link rel="icon" href="data:,">'
        + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1035.js"></script><script src="/js/gina.min.js"></script>'
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
    return page.evaluate(() => { window.__b1035.armed = true; });
}

/** Writes a value from a script. */
function write(page, id, value) {
    return page.evaluate(([i, v]) => { document.getElementById(i).value = v; }, [id, value]);
}

/** Blurs whatever holds the focus. */
function blur(page) {
    return page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
}

/** A keyboard clear of a seeded field, past its keyup timer, then a blur. */
async function clearByKeyboard(page, id) {
    await page.click('#' + id);
    await page.locator('#' + id).selectText();
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(KEYUP);
    await blur(page);
    await page.waitForTimeout(500);
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
        const fv = window.__b1035, h = window.gina.validator.$forms[fid], f = document.getElementById(fid);
        const trigger = document.getElementById(fid + '-submit');
        return {
            ariaTrue: fv.ariaTrue,
            liveWrites: fv.liveWrites,
            frames: fv.frames,
            errFrames: fv.errFrames,
            errors: h.errors ? Object.keys(h.errors) : [],
            painted: f.querySelectorAll('.form-item-error, .form-item-warning, [aria-invalid="true"]').length,
            messages: Array.prototype.map.call(f.querySelectorAll('.form-item-error-message'), (m) => m.textContent),
            gated: trigger.getAttribute('data-gina-form-submit-gated')
        };
    }, id);
}

/**
 * Nothing was painted or announced since the instruments were armed.
 *
 * @param {object} r - `read()`'s result
 * @returns {void}
 */
function expectQuiet(r) {
    expect(r.frames, 'the frame counter ran').toBeGreaterThan(0);
    expect(r.ariaTrue, 'no aria-invalid="true" written').toBe(0);
    expect(r.liveWrites, 'nothing written to the live region').toEqual([]);
    expect(r.errFrames, 'no frame shows an error or a warning').toBe(0);
    expect(r.painted, 'nothing painted').toBe(0);
    expect(r.messages, 'no message').toEqual([]);
}

test.describe('#B1035 — a script\'s write is nobody\'s touch', function () {

    for (const [label, name, id, value] of [
        ['01', 'a required text emptied', 'req', ''],
        ['02', 'an invalid non-empty write', 'mail', 'bad'],
        ['03', 'a required hidden field emptied', 'hid', '']
    ]) {
        test(label + ' #B1035 — ' + name + ': nothing painted or announced; the gate closes and the store holds it', async ({ page }) => {
            const run = await open(page, seeded(), ['seeded']);
            await arm(page);
            await write(page, id, value);
            await page.waitForTimeout(AFTER);
            const r = await read(page, 'seeded');
            expectQuiet(r);
            expect(r.gated, 'the gate closes').toBe('true');
            expect(r.errors, 'the store holds it').toContain(id);
            expect(run.errors).toEqual([]);
        });
    }

    test('04 #B1035 — emptied while it holds the focus: not even the soft warning', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await page.focus('#req');
        await arm(page);
        await write(page, 'req', '');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expectQuiet(r);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

    test('05 #B1035 — a field with a form-item-wrapper: the same', async ({ page }) => {
        const run = await open(page, form('emptyone', '<div class="box"><div class="form-item-wrapper"><input id="req" type="text" name="req" value="seed"></div></div>'
            + wrap('<input id="keep" type="text" name="keep" value="seed2">')), ['emptyone']);
        await arm(page);
        await write(page, 'req', '');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'emptyone');
        expectQuiet(r);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

    test('06 #B1035 — a field with a query rule, written a value the answer refuses: nothing painted; the gate closes', async ({ page }) => {
        const queries = await answerQueries(page, false);
        const run = await open(page, form('query', wrap('<input id="r3" type="text" name="r3" value="seed">')
            + wrap('<input id="q3" type="text" name="q3">')), ['query']);
        await arm(page);
        await write(page, 'q3', 'taken');
        await expect.poll(() => queries.n, { timeout: 4000 }).toBeGreaterThan(0);
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'query');
        expectQuiet(r);
        expect(r.gated, 'the gate closes').toBe('true');
        expect(r.errors, 'the store holds it').toContain('q3');
        expect(run.errors).toEqual([]);
    });

    test('07 #B1035 — a script empties a field, the user works on ANOTHER field: the first stays quiet', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await arm(page);
        await write(page, 'req', '');
        await page.waitForTimeout(300);
        await page.locator('#keep').click();
        await page.locator('#keep').pressSequentially('x', { delay: 30 });
        await page.waitForTimeout(KEYUP);
        await blur(page);
        await page.waitForTimeout(500);
        const r = await read(page, 'seeded');
        expectQuiet(r);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

    test('08 CONTROL — a real change dispatched after the write paints', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await arm(page);
        await page.evaluate(() => { const e = document.getElementById('req'); e.value = ''; e.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expect(r.ariaTrue, 'the instrument can fire').toBeGreaterThan(0);
        expect(r.errFrames).toBeGreaterThan(0);
        expect(r.liveWrites.length).toBeGreaterThan(0);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

    test('09 CONTROL — a keyboard clear and a blur paint', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await arm(page);
        await clearByKeyboard(page, 'req');
        const r = await read(page, 'seeded');
        expect(r.ariaTrue).toBeGreaterThan(0);
        expect(r.messages.length).toBe(1);
        expect(run.errors).toEqual([]);
    });

    test('10 CONTROL — the user then touches that field: it paints', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await write(page, 'req', '');
        await page.waitForTimeout(AFTER);
        await arm(page);
        await page.click('#req');
        await page.keyboard.press('a');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(KEYUP);
        await blur(page);
        await page.waitForTimeout(500);
        const r = await read(page, 'seeded');
        expect(r.ariaTrue).toBeGreaterThan(0);
        expect(r.messages.length).toBe(1);
        expect(run.errors).toEqual([]);
    });

    test('11 CONTROL — a click on the gated trigger reveals the error the write left in the store', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await write(page, 'req', '');
        await page.waitForTimeout(AFTER);
        await arm(page);
        await page.click('#seeded-submit', { force: true });
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expect(r.ariaTrue, 'the click reveals it').toBeGreaterThan(0);
        expect(run.posts).toEqual([]);
        expect(run.errors).toEqual([]);
    });

    test('12 CONTROL — an error showing from a touch, a valid write: the message clears', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await clearByKeyboard(page, 'req');
        expect((await read(page, 'seeded')).messages.length, 'the error is showing').toBe(1);
        await write(page, 'req', 'ok');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expect(r.messages).toEqual([]);
        expect(r.painted).toBe(0);
        expect(r.gated).toBeNull();
        expect(run.errors).toEqual([]);
    });

    for (const [label, name, body, id] of [
        ['13', 'an error showing from a touch', seeded(), 'seeded'],
        ['13b', 'the same on a field with a form-item-wrapper', form('seeded', '<div class="box"><div class="form-item-wrapper"><input id="mail" type="text" name="mail" value="a@b.co"></div></div>'
            + wrap('<input id="keep" type="text" name="keep" value="seed2">')), 'seeded']
    ]) {
        test(label + ' CONTROL — ' + name + ', a write that is still invalid: the message changes', async ({ page }) => {
            const run = await open(page, body, [id]);
            await clearByKeyboard(page, 'mail');
            const before = (await read(page, id)).messages;
            expect(before.length, 'the error is showing').toBe(1);
            await write(page, 'mail', 'bad');
            await page.waitForTimeout(AFTER);
            const r = await read(page, id);
            expect(r.messages.length, 'a message still shows').toBe(1);
            expect(r.messages[0], 'and it is the new error').not.toBe(before[0]);
            expect(r.gated).toBe('true');
            expect(run.errors).toEqual([]);
        });
    }

    test('14 CONTROL — a value written into an empty required field opens the gate', async ({ page }) => {
        const run = await open(page, emptyOne(), ['emptyone']);
        expect((await read(page, 'emptyone')).gated, 'gated at bind').toBe('true');
        await arm(page);
        await write(page, 'req', 'ok');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'emptyone');
        expectQuiet(r);
        expect(r.gated, 'the gate opens').toBeNull();
        await page.click('#emptyone-submit');
        await expect.poll(() => run.posts.length, { timeout: 4000 }).toBe(1);
        expect(run.errors).toEqual([]);
    });

    test('15 #B1035 — written back to its default: nothing painted, the gate open', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await arm(page);
        await write(page, 'req', '');
        await page.waitForTimeout(AFTER);
        await page.evaluate(() => { window.__b1035.ariaTrue = 0; window.__b1035.liveWrites = []; window.__b1035.errFrames = 0; });
        await write(page, 'req', 'seed');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expectQuiet(r);
        expect(r.gated).toBeNull();
        expect(run.errors).toEqual([]);
    });

    test('16 CONTROL — a valid write paints nothing, the gate stays open', async ({ page }) => {
        const run = await open(page, seeded(), ['seeded']);
        await arm(page);
        await write(page, 'req', 'new');
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'seeded');
        expectQuiet(r);
        expect(r.gated).toBeNull();
        expect(run.errors).toEqual([]);
    });

    test('17 CONTROL — autocomplete="off": a keyboard clear and a blur paint', async ({ page }) => {
        const run = await open(page, form('emptyone', wrap('<input id="req" type="text" name="req" value="seed" autocomplete="off">')
            + wrap('<input id="keep" type="text" name="keep" value="seed2">')), ['emptyone']);
        await arm(page);
        await page.click('#req');
        await page.locator('#req').selectText();
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(KEYUP);
        await blur(page);
        await page.waitForTimeout(500);
        const r = await read(page, 'emptyone');
        expect(await page.inputValue('#req')).toBe('');
        expect(r.ariaTrue).toBeGreaterThan(0);
        expect(r.messages.length).toBe(1);
        expect(run.errors).toEqual([]);
    });

    for (const id of ['tel1', 'note']) {
        test('18 CONTROL — no value setter on #' + id + ': a write re-checks nothing, a change dispatched after it does', async ({ page }) => {
            const run = await open(page, form('nosetter', wrap('<input id="tel1" type="tel" name="tel1" value="123">')
                + wrap('<textarea id="note" name="note">seed</textarea>')), ['nosetter']);
            expect((await read(page, 'nosetter')).gated, 'valid at bind').toBeNull();
            await write(page, id, '');
            await page.waitForTimeout(AFTER);
            expect((await read(page, 'nosetter')).gated, 'the write re-checks nothing').toBeNull();
            await page.evaluate((i) => { document.getElementById(i).dispatchEvent(new Event('change', { bubbles: true })); }, id);
            await page.waitForTimeout(AFTER);
            expect((await read(page, 'nosetter')).gated, 'the change does').toBe('true');
            expect(run.errors).toEqual([]);
        });
    }

    for (const [label, name, target] of [
        ['19', 'a click on the radio', '#no'],
        ['19b', 'a click on its label', '#for-no']
    ]) {
        test(label + ' #B1035 — a pick on a boolean radio, refused by its rule, paints: ' + name, async ({ page }) => {
            const run = await open(page, form('boolr', wrap('<input id="yes" type="radio" name="agree" value="true">')
                + wrap('<label id="for-no" for="no">No</label><input id="no" type="radio" name="agree" value="false">')), ['boolr']);
            await page.locator(target).click();
            await page.waitForTimeout(AFTER);
            const r = await read(page, 'boolr');
            expect(r.messages, 'the message of the refused pick').toEqual(['Condition not satisfied']);
            expect(r.gated, 'the gate closed').toBe('true');
            expect(r.errors, 'the store holds it').toEqual(['agree']);
            expect(run.errors).toEqual([]);
        });
    }

    test('20 CONTROL — a value radio, refused by its rule, paints', async ({ page }) => {
        const run = await open(page, form('valr', wrap('<input id="a" type="radio" name="pick" value="a">')
            + wrap('<input id="b" type="radio" name="pick" value="b">')), ['valr']);
        await page.locator('#b').click();
        await page.waitForTimeout(AFTER);
        const r = await read(page, 'valr');
        expect(r.messages).toEqual(['Condition not satisfied']);
        expect(r.gated).toBe('true');
        expect(run.errors).toEqual([]);
    });

});
