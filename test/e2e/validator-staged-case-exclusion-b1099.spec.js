'use strict';

/**
 * #B1099 — a staged file input's own value stays out of the posted data when the input has a rule
 * of its own and a matching `_case_` condition names it too.
 *
 * A staged file input never posts its own value: its files travel in the hidden fields the staging
 * wrote (or the saved-file fields an edit form shows), and the pass leaves the value it judges (the
 * names of the files the input holds, or '') out of the data (#B1058). The scan loop's check of a field
 * that a matching `_case_` condition names deletes it from the collected values before that exclusion
 * ran, and the exclusion walked those values, so the value was posted. It shows on the wire when the
 * files' fields come before the input (the value, nested last, replaces the list) and when the input
 * holds no file under a rule that allows that (`"doc":""`). In the default order of a fresh staging the
 * fields come after the input and the list wins, so these arms use the two shapes that show.
 *
 * A rule of its own is one under the input's name or under a top-level key written as a regular
 * expression that matches it: `bindForm` runs `checkForRuleAlias` on every owned input, a staged one
 * included. The RegExp arms use `/^doc$/`, which matches the input and none of its fields.
 *
 *   E1  [#B1099] required, an edit form showing a saved file whose fields come before the input, a
 *       top-level rule and a matching case rule: the first click sends the saved file's list
 *   E2  [#B1099] optional in both places, no file: the form is sent with no `doc` key
 *   E3  [#B1099] E1 with the RegExp key `/^doc$/` at the top level and in the condition
 *   E4  [#B1099] E2 with the RegExp keys
 *   E5  CONTROL  E1's page with the top-level rule only: the saved file's list (both bundles)
 *   E6  CONTROL  a required staged input under a top-level RegExp key alone, no file: the submit is
 *       refused and the input is marked invalid (both bundles: a RegExp key judged a staged input in
 *       0.7.9 too)
 *
 * RED-FIRST: B1099_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves those bytes to every arm
 * (page.route, nothing written to the tree; E5 and E6 assert that the swap ran).
 *
 * Run (local; WebKit: GINA_E2E_ENGINES=all ... --project=webkit):
 *   GINA_E2E_PORT=3293 npx playwright test test/e2e/validator-staged-case-exclusion-b1099.spec.js --project=chromium --workers=1
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

// a fresh staged input, holding no file
const FRESH = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';

// an edit form showing one saved file, its fields rendered BEFORE the input
const SAVED_BEFORE = '<input type="hidden" name="doc[0][name]" value="old.png">'
    + '<input type="hidden" name="doc[0][location]" value="/media/stored/old.png">'
    + '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';

const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

/**
 * A page whose form `b459form` names one of the #B1099 rule sets and holds a title, the case driver
 * `kind` set to `pro`, and the staged input's markup.
 *
 * @param {string} ruleSet - the rule set the form names in `data-gina-form-rule`
 * @param {string} inner - the staged input's markup
 * @returns {string} the page
 */
function page(ruleSet, inner) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b1099</title>'
        + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1099.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>'
        + '<form id="b459form" data-gina-form-rule="' + ruleSet + '" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">'
        + '<input id="kindA" type="text" name="kind" value="pro">'
        + inner + FORM_CLOSE + DECLARED + '</body></html>';
}

/**
 * Opens a page on the runtime server and waits for the form to be bound. No staging is planned: a
 * staging request is answered 500 and counted.
 *
 * @param {object} pw - the Playwright page
 * @param {string} html - the page
 * @returns {Promise<object>} the arm's record
 */
async function open(pw, html) {
    const log = { saves: [], errors: [], routeHits: 0, staged: 0 };
    if (process.env.B1099_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1099_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await pw.route('**/upload-stage', async (route) => {
        log.staged++;
        await route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ status: 500, error: 'no staging planned' }) });
    });
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('request', (r) => {
        if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { log.saves.push(r.postData() || ''); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms.b459form), null, { timeout: 15000 });
    return log;
}

/**
 * What the staged input holds and how the form marks it: its entries, its aria-invalid, and the
 * submit trigger's not-ready mark (#B312).
 *
 * @param {object} pw - the Playwright page
 * @returns {Promise<object>} the input's state
 */
function state(pw) {
    return pw.evaluate(() => {
        const $in = document.getElementById('docA');
        return {
            customFiles: ($in.customFiles || []).map((f) => f.name),
            docInvalid: $in.getAttribute('aria-invalid'),
            gated: document.getElementById('b459form-submit').getAttribute('data-gina-form-submit-gated')
        };
    });
}

/**
 * Clicks the submit trigger once and waits 1.5 s: the count of save requests that click sent, the
 * last save body parsed (or as text), and that body as sent.
 *
 * @param {object} pw - the Playwright page
 * @param {object} log - the arm's record
 * @returns {Promise<{sent: number, body: *, raw: (string|null)}>}
 */
async function clickOnce(pw, log) {
    const before = log.saves.length;
    await pw.click('#b459form-submit', { force: true });
    await pw.waitForTimeout(1500);
    let body = log.saves.length ? log.saves[log.saves.length - 1] : null;
    const raw = body;
    try { body = JSON.parse(body); } catch (e) { /* kept as text */ }
    return { sent: log.saves.length - before, body: body, raw: raw };
}

/**
 * What a save body holds under `doc`: '(no doc key)', or the posted value.
 *
 * @param {*} body - the parsed save body
 * @returns {*} the value under `doc`
 */
function docOf(body) {
    return (body && typeof body === 'object') ? (('doc' in body) ? body.doc : '(no doc key)') : body;
}

/**
 * The positive control of the red-first seam: the swapped bundle was served.
 *
 * @param {object} log - the arm's record
 * @returns {void}
 */
function swapRan(log) {
    if (process.env.B1099_PREFIX_BUNDLE) {
        expect(log.routeHits, 'the swapped bundle was served').toBeGreaterThan(0);
    }
}

/**
 * Prints and annotates one arm's readings, and checks that no staging request went out.
 *
 * @param {string} name - the arm
 * @param {object} log - the arm's record
 * @param {object} [extra] - the arm's readings
 * @returns {void}
 */
function record(name, log, extra) {
    const out = Object.assign({ arm: name, bundle: process.env.B1099_PREFIX_BUNDLE ? 'swapped' : 'tree',
        routeHits: log.routeHits, pageErrors: log.errors }, extra || {});
    console.log('B1099-RECORD ' + JSON.stringify(out));
    test.info().annotations.push({ type: 'b1099', description: JSON.stringify(out) });
    expect(log.staged, 'no staging request went out').toBe(0);
}

/**
 * The saved file's list a save body carries under `doc`, as its locations (null when `doc` is not a list).
 *
 * @param {*} body - the parsed save body
 * @returns {(Array<string>|null)} the locations
 */
function savedList(body) {
    const doc = docOf(body);
    return Array.isArray(doc) ? doc.map((d) => (d && d.location) || null) : null;
}

test.describe('#B1099 - a staged file input\'s own value stays out of the data under a rule of its own and a matching case rule', () => {

    test('E1 required, saved-file fields before the input, a top-level rule and a matching case rule: the list is sent', async ({ page: pw }) => {
        const log = await open(pw, page('b1099req', SAVED_BEFORE));
        const atBind = await state(pw);
        const click = await clickOnce(pw, log);
        record('E1', log, { atBind: atBind, sent: click.sent, doc: docOf(click.body) });
        expect(atBind.customFiles, 'the saved file is the input\'s entry').toEqual(['old.png']);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(savedList(click.body), 'the saved file\'s list is sent, not the input\'s value').toEqual(['/media/stored/old.png']);
        expect(click.raw, 'no scalar for the staged input').not.toContain('"doc":"');
        expect(log.errors).toEqual([]);
    });

    test('E2 optional in both places, no file: the form is sent with no doc key', async ({ page: pw }) => {
        const log = await open(pw, page('b1099opt', FRESH));
        const click = await clickOnce(pw, log);
        record('E2', log, { sent: click.sent, doc: docOf(click.body) });
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });

    test('E3 E1 with a top-level RegExp key and a RegExp key in the condition: the list is sent', async ({ page: pw }) => {
        const log = await open(pw, page('b1099rereq', SAVED_BEFORE));
        const atBind = await state(pw);
        const click = await clickOnce(pw, log);
        record('E3', log, { atBind: atBind, sent: click.sent, doc: docOf(click.body) });
        expect(atBind.customFiles, 'the saved file is the input\'s entry').toEqual(['old.png']);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(savedList(click.body), 'the saved file\'s list is sent, not the input\'s value').toEqual(['/media/stored/old.png']);
        expect(click.raw, 'no scalar for the staged input').not.toContain('"doc":"');
        expect(log.errors).toEqual([]);
    });

    test('E4 E2 with the RegExp keys: the form is sent with no doc key', async ({ page: pw }) => {
        const log = await open(pw, page('b1099reopt', FRESH));
        const click = await clickOnce(pw, log);
        record('E4', log, { sent: click.sent, doc: docOf(click.body) });
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });

    test('E5 CONTROL - E1\'s page with the top-level rule only: the list is sent', async ({ page: pw }) => {
        const log = await open(pw, page('b1099top', SAVED_BEFORE));
        const click = await clickOnce(pw, log);
        record('E5', log, { sent: click.sent, doc: docOf(click.body) });
        swapRan(log);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(savedList(click.body), 'the saved file\'s list is sent').toEqual(['/media/stored/old.png']);
        expect(log.errors).toEqual([]);
    });

    test('E6 CONTROL - a required staged input under a top-level RegExp key alone, no file: the submit is refused', async ({ page: pw }) => {
        const log = await open(pw, page('b1099reonly', FRESH));
        const click = await clickOnce(pw, log);
        const after = await state(pw);
        record('E6', log, { sent: click.sent, after: after });
        swapRan(log);
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });
});
