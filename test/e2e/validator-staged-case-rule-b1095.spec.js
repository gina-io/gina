'use strict';

/**
 * #B1095 — a rule that a `_case_` condition gives a staged file input judges the files the input holds.
 *
 * A staged file input never posts its own value: its rules judge the names of the files it holds (the
 * files it staged, a selection still staging, the saved files an edit form shows), and the pass leaves
 * that value out of the data (#B1058, #B1099). Before #B1095 the collectors gave a staged input those
 * names only under a rule of its own, so a staged input that only a matching `_case_` condition named
 * was judged on nothing when the rule file held one `_case_` key (a required staged input refused
 * nothing), and on its own value when the input's driver was not the last of two or more keys (`''`
 * for an edit form showing a saved file: refused). The submit gate followed the input's files only when
 * the input had a rule of its own. Now the condition's rule judges the files the input holds, and the
 * gate re-syncs on a file change when the form's rules hold a `_case_` key. In every form here the
 * staged input has no rule of its own.
 *
 *   K1  [#B1095] required by the case rule, no file: the submit is refused and the input marked invalid
 *   K2  required by the case rule, a staged file: it opens the trigger, and the first click sends the
 *       file, with no scalar for the input
 *   K3  [#B1095] required by the case rule, a staged file then its reset: the trigger is marked not
 *       ready again and the submit is refused
 *   K4  [#B1095] two `_case_` keys, the input named by the first, an edit form showing a saved file: the
 *       first click sends the saved file's list
 *   K5  CONTROL  optional by the case rule, no file: the form is sent with no `doc` key (both bundles)
 *   K6  CONTROL  required by the case rule, a case that does not match, no file: the form is sent with
 *       no `doc` key (both bundles)
 *
 * RED-FIRST: B1095_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves those bytes to every arm
 * (page.route, nothing written to the tree; K5 and K6 assert that the swap ran). Measured 2026-11-07 in
 * Chromium on develop `4a1765b11`'s bundle (md5 603a3d8f; it carries #B1099 and not #B1095): K1, K3
 * and K4 fail and K2, K5 and K6 pass. K1 sends the form with no file; after K3's reset the trigger is
 * not marked and the form is sent; K4 refuses the edit form and marks the input invalid (it is judged
 * on its own value ''). With no case rule applied, K2's form is sent as well. On this branch's bundle
 * all six pass.
 *
 * Run (local; WebKit: GINA_E2E_ENGINES=all ... --project=webkit):
 *   GINA_E2E_PORT=3294 npx playwright test test/e2e/validator-staged-case-rule-b1095.spec.js --project=chromium --workers=1
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

// a fresh staged input, holding no file
const FRESH = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';

// an edit form showing one saved file, with its fields and its delete link
const SAVED_ONE = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<input type="hidden" name="doc[0][name]" value="old.png"><input type="hidden" name="doc[0][location]" value="/media/stored/old.png">'
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';

// the driver of the second `_case_` key of `b1095two`
const OTHER = '<input id="otherA" type="text" name="other" value="x">';

const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

/**
 * A page whose form `b459form` names one of the #B1095 rule sets (served by `/js/gina.onload.b1095.js`)
 * and holds a title, the case driver `kind`, and the staged input's markup.
 *
 * @param {string} ruleSet - the rule set the form names in `data-gina-form-rule`
 * @param {string} kind - the value of the case driver `kind` (`pro` matches the condition)
 * @param {string} inner - the staged input's markup, and any other control
 * @returns {string} the page
 */
function page(ruleSet, kind, inner) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b1095</title>'
        + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1095.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>'
        + '<form id="b459form" data-gina-form-rule="' + ruleSet + '" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">'
        + '<input id="kindA" type="text" name="kind" value="' + kind + '">'
        + inner + FORM_CLOSE + DECLARED + '</body></html>';
}

/**
 * One PNG file for `setInputFiles`.
 *
 * @param {string} name - the file's name
 * @returns {{name: string, mimeType: string, buffer: Buffer}}
 */
function file(name) { return { name: name, mimeType: 'image/png', buffer: PNG }; }

/**
 * The staging answer for one file, as the upload action would answer it.
 *
 * @param {string} name - the file's name
 * @returns {object} the file's staging metadata
 */
function answer(name) {
    return { name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-' + name, mime: 'image/png', tmpUri: '/upload-tmp/staged-' + name };
}

/**
 * The staging route of one arm: the Nth staging request gets the plan's Nth step (`{ ok: <name> }`),
 * never an answer read from the request body; an unplanned request is answered 500 and counted.
 *
 * @param {Array<object>} plan - the arm's steps, in request order
 * @param {object} log - the arm's record (`answered`, `unplanned`, `unanswerable`)
 * @returns {Function} the route handler
 */
function stager(plan, log) {
    let next = 0;
    return async (route) => {
        const step = plan[next++];
        try {
            if (!step) {
                log.unplanned++;
                return await route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
                    body: JSON.stringify({ status: 500, error: 'no step planned' }) });
            }
            log.answered++;
            return await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ files: [answer(step.ok)] }) });
        } catch (e) {
            log.unanswerable++;
        }
    };
}

/**
 * Opens a page on the runtime server, with the arm's staging plan, and waits for the form to be bound.
 *
 * @param {object} pw - the Playwright page
 * @param {string} html - the page
 * @param {Array<object>} plan - the staging plan (see stager)
 * @returns {Promise<object>} the arm's record
 */
async function open(pw, html, plan) {
    const log = { stage: [], remove: [], saves: [], errors: [], routeHits: 0, answered: 0, unplanned: 0, unanswerable: 0 };
    if (process.env.B1095_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1095_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await pw.route('**/upload-stage', stager(plan, log));
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage.push(r.method()); }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
        if (u.indexOf('/upload-save') > -1 && r.method() === 'POST') { log.saves.push(r.postData() || ''); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms.b459form), null, { timeout: 15000 });
    return log;
}

/**
 * The staged input's entries, its aria-invalid, and the submit trigger's not-ready mark (#B312).
 *
 * @param {object} pw - the Playwright page
 * @returns {Promise<{customFiles: Array<string>, docInvalid: (string|null), gated: (string|null)}>}
 */
function state(pw) {
    return pw.evaluate(() => {
        const $in = document.getElementById('docA');
        return {
            customFiles: ($in.customFiles || []).map((f) => f && f.name),
            docInvalid: $in.getAttribute('aria-invalid'),
            gated: document.getElementById('b459form-submit').getAttribute('data-gina-form-submit-gated')
        };
    });
}

/**
 * Waits until `count` staging requests went out.
 *
 * @param {object} log - the arm's record
 * @param {number} count - the expected count
 * @returns {Promise<boolean>} false when they did not within 6 s
 */
function staged(log, count) {
    return expect.poll(() => log.stage.length, { timeout: 6000 }).toBe(count).then(() => true, () => false);
}

/**
 * Waits until a control of form b459form holds a value.
 *
 * @param {object} pw - the Playwright page
 * @param {string} name - the control's name
 * @param {string} value - the value
 * @returns {Promise<boolean>} false when it did not within 6 s
 */
function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

/**
 * Clicks the submit trigger once and waits 1.5 s: the count of save requests that click sent, the last
 * save body parsed (or as text), and that body as sent.
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
    if (process.env.B1095_PREFIX_BUNDLE) {
        expect(log.routeHits, 'the swapped bundle was served').toBeGreaterThan(0);
    }
}

/**
 * Prints and annotates one arm's readings, and checks that every staging request had a planned answer.
 *
 * @param {string} name - the arm
 * @param {object} log - the arm's record
 * @param {object} [extra] - the arm's readings
 * @returns {void}
 */
function record(name, log, extra) {
    const out = Object.assign({ arm: name, bundle: process.env.B1095_PREFIX_BUNDLE ? 'swapped' : 'tree',
        routeHits: log.routeHits, stage: log.stage.length, answered: log.answered, unanswerable: log.unanswerable,
        removals: log.remove, pageErrors: log.errors }, extra || {});
    console.log('B1095-RECORD ' + JSON.stringify(out));
    test.info().annotations.push({ type: 'b1095', description: JSON.stringify(out) });
    expect(log.unplanned, 'every staging request had a planned answer').toBe(0);
}

test.describe('#B1095 - a `_case_` rule on a staged file input judges the files the input holds', () => {

    test('K1 required by the case rule, no file: the submit is refused and the input is marked invalid', async ({ page: pw }) => {
        const log = await open(pw, page('b1095req', 'pro', FRESH), []);
        const click = await clickOnce(pw, log);
        const after = await state(pw);
        record('K1', log, { sent: click.sent, after: after });
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('K2 required by the case rule, a staged file: it opens the trigger, and the first click sends the file', async ({ page: pw }) => {
        const log = await open(pw, page('b1095req', 'pro', FRESH), [{ ok: 'a.png' }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const done = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const afterStaging = await state(pw);
        const click = await clickOnce(pw, log);
        record('K2', log, { filled: done, afterStaging: afterStaging, sent: click.sent, doc: docOf(click.body) });
        expect(done, 'the staging filled the form').toBe(true);
        expect(afterStaging.gated, 'the staged file opens the trigger').toBe(null);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(Array.isArray(docOf(click.body)) && docOf(click.body).map((d) => d && d.originalFilename), 'the staged file rides the body').toEqual(['a.png']);
        expect(click.raw, 'the input\'s own value is not posted').not.toContain('fakepath');
        expect(click.raw, 'no scalar for the staged input').not.toContain('"doc":"');
        expect(log.errors).toEqual([]);
    });

    test('K3 required by the case rule, a staged file then its reset: the trigger is marked not ready again and the submit is refused', async ({ page: pw }) => {
        const log = await open(pw, page('b1095req', 'pro', FRESH), [{ ok: 'a.png' }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const done = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const afterStaging = await state(pw);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length, { timeout: 4000 }).toBe(1).catch(() => {});
        await pw.waitForTimeout(300);
        const afterReset = await state(pw);
        const click = await clickOnce(pw, log);
        const after = await state(pw);
        record('K3', log, { filled: done, afterStaging: afterStaging, afterReset: afterReset, sent: click.sent, after: after });
        expect(done, 'the staging filled the form').toBe(true);
        expect(afterStaging.gated, 'the staged file opens the trigger').toBe(null);
        expect(log.remove, 'the reset unstages the file').toEqual(['POST {"files":["a.png"]}']);
        expect(afterReset.gated, 'the reset marks the trigger not ready again').toBe('true');
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('K4 two `_case_` keys, the input named by the first, an edit form showing a saved file: the first click sends it', async ({ page: pw }) => {
        const log = await open(pw, page('b1095two', 'pro', SAVED_ONE + OTHER), []);
        const atBind = await state(pw);
        const click = await clickOnce(pw, log);
        const after = await state(pw);
        const list = Array.isArray(docOf(click.body)) ? docOf(click.body).map((d) => (d && d.location) || null) : null;
        record('K4', log, { atBind: atBind, sent: click.sent, doc: docOf(click.body), after: after });
        expect(atBind.customFiles, 'the saved file is the input\'s entry').toEqual(['old.png']);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(list, 'the saved file\'s list is sent').toEqual(['/media/stored/old.png']);
        expect(after.docInvalid, 'the staged input is not marked invalid').not.toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('K5 CONTROL - optional by the case rule, no file: the form is sent with no doc key', async ({ page: pw }) => {
        const log = await open(pw, page('b1095opt', 'pro', FRESH), []);
        const click = await clickOnce(pw, log);
        record('K5', log, { sent: click.sent, doc: docOf(click.body) });
        swapRan(log);
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });

    test('K6 CONTROL - required by the case rule, a case that does not match, no file: the form is sent', async ({ page: pw }) => {
        const log = await open(pw, page('b1095req', 'basic', FRESH), []);
        const click = await clickOnce(pw, log);
        record('K6', log, { sent: click.sent, doc: docOf(click.body) });
        swapRan(log);
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });
});
