'use strict';

/**
 * #B960 / #B961 — a file selection takes the file input over only when its staging succeeds.
 *
 * The file input's change listener used to write the input's entries (the files its reset and
 * delete links act on), keep the stored entries the selection replaced, and build the form's hidden
 * fields, all at the selection, while the staging settle emptied the preview container on every
 * answer. So a FAILED staging left the page and the form out of step (#B960): the previews of the
 * files the input still held were gone, a stored file's delete link sent nothing, a staged file's
 * reset link was gone while its fields were still posted, and the fields the failed selection had
 * created were posted empty. While a staging was on the wire (#B961), a delete of the stored file
 * sent nothing, and a reset of the previous file took the new file's fields out of the form before
 * the answer filled them, so the save posted no file. Since the fix a failed staging changes nothing
 * on the page or in the save, and while a file stages the files shown keep working.
 *
 *   C0 CONTROL  an edit form, no selection: the stored file's delete link sends one DELETE
 *   C1 CONTROL  an edit form, no selection: the save posts the stored file
 *   F1  an edit form (delete link after the container), a failed staging: the preview, the entry
 *       and the fields stay, and the delete link deletes the stored file
 *   F2  an image staged, then a failed staging: its preview and reset link stay, the reset unstages it
 *   F3  an edit form, the delete link INSIDE the container, a failed staging: the link stays, the
 *       save posts the stored file only, and the link deletes it
 *   F4  an edit form, the stored file deleted, then a failed staging: no field is left, the save
 *       posts no file
 *   F5  [#B961] an edit form, a slow staging: the delete link clicked during the flight deletes the
 *       stored file, and the staging still fills the form
 *   F6  [#B961] an image staged, then a slow staging: its reset clicked during the flight unstages
 *       it, and the save posts the new file
 *   G1  a custom reset trigger (`data-gina-form-upload-reset-trigger`) is bound by the selection and
 *       resets the staged file
 *
 * The staging route answers from each arm's plan, in request order, and never reads the request
 * body: on WebKit a route handler reads no multipart body.
 *
 * RED-FIRST: B960_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves the old bytes to every arm
 * (page.route, nothing written to disk; C0, C1 and G1 assert that the swap ran). F1-F6 fail on a
 * bundle without the fix, each on its own assertion; C0, C1 and G1 pass on both.
 *
 * Run (local, cached headless shell; WebKit: GINA_E2E_ENGINES=all ... --project=webkit, on its own port):
 *   GINA_E2E_PORT=3297 PW_CHROME=<chrome-headless-shell> npx playwright test \
 *     test/e2e/validator-upload-failed-staging-b960.spec.js --project=chromium
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const B150 = /preview\(s\) present but none matched/;
const SLOW = 2000;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b960</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

const FORM_OPEN = '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">';
const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

const STORED = '<input type="hidden" name="doc[0][name]" value="old.png">'
    + '<input type="hidden" name="doc[0][location]" value="/media/stored/old.png">';
const EDIT_AFTER = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + STORED
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';
const EDIT_INSIDE = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + STORED
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt="">'
    + '<a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';
const FRESH = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';
const CUSTOM = '<input id="docA" type="file" name="doc" ' + ACTIONS + ' data-gina-form-upload-reset-trigger="myReset">'
    + '<div id="docA-preview"></div><a href="#" id="myReset">Clear</a><p id="docA-error" hidden></p>';

const STORED_DOC = [{ name: 'old.png', location: '/media/stored/old.png' }];

function page(inner) { return HEAD + FORM_OPEN + inner + FORM_CLOSE + DECLARED + '</body></html>'; }
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
 * The staging route of one arm: the Nth staging request gets the plan's Nth step, never an answer
 * read from the request body. A step is `{ ok: <file name>, delay: <ms> }` or `{ fail: true }`.
 *
 * @param {Array<object>} plan - the arm's steps, in request order
 * @param {object} log - the arm's record (`answered` counts the answers sent)
 * @returns {Function} the route handler
 */
function stager(plan, log) {
    let next = 0;
    return async (route) => {
        const step = plan[next++];
        if (!step) {
            log.unplanned++;
            return route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ status: 500, error: 'no step planned' }) });
        }
        if (step.delay) { await new Promise((r) => setTimeout(r, step.delay)); }
        log.answered++;
        if (step.fail) {
            return route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ status: 500, error: 'staging refused' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: [answer(step.ok)] }) });
    };
}

async function open(pw, html, plan) {
    const log = { stage: [], remove: [], answeredAtRemoval: [], saves: [], b150: [], errors: [], routeHits: 0, answered: 0, unplanned: 0 };
    if (process.env.B960_PREFIX_BUNDLE) {
        const body = require('fs').readFileSync(process.env.B960_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await pw.route('**/upload-stage', stager(plan, log));
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('console', (m) => { if (m.type() === 'warning' && B150.test(m.text())) { log.b150.push(m.text()); } });
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage.push(r.method()); }
        if (u.indexOf('/upload-unstage') > -1) {
            log.remove.push(r.method() + ' ' + (r.postData() || ''));
            // how many staging answers had been sent when this removal left: tells a removal made
            // while a staging was on the wire from one made after it
            log.answeredAtRemoval.push(log.answered);
        }
        if (u.indexOf('/upload-save') > -1 && r.method() === 'POST') { log.saves.push(r.postData() || ''); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms.b459form), null, { timeout: 15000 });
    return log;
}

/** What the page and the input hold for docA. */
function state(pw) {
    return pw.evaluate(() => {
        const $in = document.getElementById('docA');
        const $pv = document.getElementById('docA-preview');
        return {
            deleteLinks: ['docA-0-delete-trigger'].filter((id) => !!document.getElementById(id)),
            resetLinkPresent: !!document.getElementById('docA-0-reset-trigger'),
            previewNodes: $pv.querySelectorAll('img,[data-upload-original-filename]').length,
            previewSrcs: Array.from($pv.querySelectorAll('img')).map((i) => i.getAttribute('src')),
            customFiles: ($in.customFiles || []).map((f) => ({ name: f.name, deleteLinkId: f.deleteLinkId || null }))
        };
    });
}

/** The controls of form b459form whose name holds an index, as {name: value}. */
function fields(pw) {
    return pw.evaluate(() => {
        const out = {};
        document.getElementById('b459form').querySelectorAll('input,select,textarea').forEach((el) => {
            if (/\[\d+\]/.test(el.name)) { out[el.name] = el.value; }
        });
        return out;
    });
}

function filled(pw, name, value, timeout) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: timeout || 6000 }).then(() => true, () => false);
}

/** Chooses a file whose staging the plan answers: true once the answer filled its location. */
async function chooseOk(pw, log, name) {
    const before = log.stage.length;
    await pw.setInputFiles('#docA', file(name));
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    return filled(pw, 'doc[0][location]', '/tmp/uploads/staged-' + name);
}

/** Chooses a file whose staging the plan refuses: true once the error is shown. */
async function chooseBad(pw, log, name) {
    const before = log.stage.length;
    await pw.setInputFiles('#docA', file(name));
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    const shown = await pw.waitForFunction(() => {
        const e = document.getElementById('docA-error');
        return !!(e && e.textContent && e.textContent.length);
    }, null, { timeout: 6000 }).then(() => true, () => false);
    await pw.waitForTimeout(300);
    return shown;
}

/** Waits for a removal request, or 2.5 s when none comes, then 300 ms. */
async function settle(pw, log, before) {
    await expect.poll(() => log.remove.length, { timeout: 2500 }).toBeGreaterThan(before || 0).catch(() => {});
    await pw.waitForTimeout(300);
}

/** Submits form b459form: what its save request posted under `doc`. */
async function save(pw, log) {
    const before = log.saves.length;
    await pw.click('#b459form-submit', { force: true });
    await expect.poll(() => log.saves.length, { timeout: 8000 }).toBeGreaterThan(before).catch(() => {});
    if (log.saves.length <= before) { return { sent: false }; }
    let body = log.saves[log.saves.length - 1];
    try { body = JSON.parse(body); } catch (e) { /* kept as text */ }
    return { sent: true, doc: (body && typeof body === 'object' && 'doc' in body) ? body.doc : (body && typeof body === 'object' ? '(no doc key)' : body) };
}

/** The positive control of the red-first seam: the swapped bundle was served. */
function swapRan(log) {
    if (process.env.B960_PREFIX_BUNDLE) {
        expect(log.routeHits, 'the swapped bundle was served').toBeGreaterThan(0);
    }
}

function record(name, log, extra) {
    const out = Object.assign({ arm: name, bundle: process.env.B960_PREFIX_BUNDLE ? 'swapped' : 'tree', routeHits: log.routeHits,
        stage: log.stage.length, answered: log.answered, removals: log.remove, b150Warnings: log.b150.length,
        pageErrors: log.errors }, extra || {});
    console.log('B960-RECORD ' + JSON.stringify(out));
    test.info().annotations.push({ type: 'b960', description: JSON.stringify(out) });
    expect(log.unplanned, 'every staging request had a planned answer').toBe(0);
}

test.describe('#B960 / #B961 - a failed or in-flight staging next to a stored or staged file', () => {

    test('C0 CONTROL - an edit form, no selection: the stored file\'s delete link sends one DELETE', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_AFTER), []);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        record('C0', log);
        swapRan(log);
        expect(log.remove).toEqual(['DELETE ']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('C1 CONTROL - an edit form, no selection: the save posts the stored file', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_AFTER), []);
        const saved = await save(pw, log);
        record('C1', log, { save: saved });
        swapRan(log);
        expect(saved.sent, 'the save request was captured').toBe(true);
        expect(saved.doc).toEqual(STORED_DOC);
        expect(log.errors).toEqual([]);
    });

    test('F1 an edit form, a failed staging: the preview, the entry and the fields stay, and the delete link deletes the stored file', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_AFTER), [{ fail: true }]);
        expect(await chooseBad(pw, log, 'bad.png'), 'the staging error is shown').toBe(true);
        const afterFailure = await state(pw);
        const fieldsAfterFailure = await fields(pw);
        record('F1', log, { afterFailure: afterFailure, fieldsAfterFailure: fieldsAfterFailure });
        expect(afterFailure.previewSrcs, 'the stored file\'s preview stays').toEqual(['/upload-tmp/old.png']);
        expect(afterFailure.deleteLinks).toEqual(['docA-0-delete-trigger']);
        expect(afterFailure.customFiles, 'the stored entry stays on the input').toEqual([{ name: 'old.png', deleteLinkId: 'docA-0-delete-trigger' }]);
        expect(fieldsAfterFailure, 'the failed selection leaves no field in the form').toEqual({ 'doc[0][name]': 'old.png', 'doc[0][location]': '/media/stored/old.png' });
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        const afterClick = await state(pw);
        expect(log.remove, 'the delete request went out').toEqual(['DELETE ']);
        expect(afterClick.deleteLinks, 'the link went with the file').toEqual([]);
        expect(afterClick.previewNodes, 'and its preview').toBe(0);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F2 an image staged, then a failed staging: its preview and reset link stay, and the reset unstages it', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ ok: 'a.png' }, { fail: true }]);
        expect(await chooseOk(pw, log, 'a.png'), 'the first staging filled the fields').toBe(true);
        expect(await chooseBad(pw, log, 'bad.png'), 'the staging error is shown').toBe(true);
        const afterFailure = await state(pw);
        const fieldsAfterFailure = await fields(pw);
        record('F2', log, { afterFailure: afterFailure, fieldsAfterFailure: fieldsAfterFailure });
        expect(afterFailure.previewSrcs, 'the staged image\'s preview stays').toEqual(['/upload-tmp/staged-a.png']);
        expect(afterFailure.resetLinkPresent, 'its reset link stays').toBe(true);
        expect(afterFailure.customFiles, 'its entry stays on the input').toEqual([{ name: 'a.png', deleteLinkId: null }]);
        expect(fieldsAfterFailure['doc[0][location]'], 'its fields stay').toBe('/tmp/uploads/staged-a.png');
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        const afterReset = await state(pw);
        expect(log.remove, 'the reset unstages the staged image').toEqual(['POST {"files":["a.png"]}']);
        expect(afterReset.resetLinkPresent, 'the reset link went with the file').toBe(false);
        expect(afterReset.previewNodes, 'and its preview').toBe(0);
        expect(await fields(pw), 'and its fields').toEqual({});
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F3 an edit form, the delete link inside the container, a failed staging: the link stays, the save posts the stored file only, and the link deletes it', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_INSIDE), [{ fail: true }]);
        expect(await chooseBad(pw, log, 'bad.png'), 'the staging error is shown').toBe(true);
        const afterFailure = await state(pw);
        const saved = await save(pw, log);
        record('F3', log, { afterFailure: afterFailure, save: saved });
        expect(afterFailure.deleteLinks, 'the link inside the container stays').toEqual(['docA-0-delete-trigger']);
        expect(afterFailure.previewSrcs, 'with the stored file\'s preview').toEqual(['/upload-tmp/old.png']);
        expect(saved.sent, 'the save request was captured').toBe(true);
        expect(saved.doc, 'the save posts the stored file, and no field of the failed selection').toEqual(STORED_DOC);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        expect(log.remove, 'the delete request went out').toEqual(['DELETE ']);
        expect((await state(pw)).deleteLinks, 'the link went with the file').toEqual([]);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F4 an edit form, the stored file deleted, then a failed staging: no field is left and the save posts no file', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_AFTER), [{ fail: true }]);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        expect(log.remove, 'the delete request went out').toEqual(['DELETE ']);
        expect(await fields(pw), 'the deleted file\'s fields are gone').toEqual({});
        expect(await chooseBad(pw, log, 'bad.png'), 'the staging error is shown').toBe(true);
        const fieldsAfterFailure = await fields(pw);
        const saved = await save(pw, log);
        record('F4', log, { fieldsAfterFailure: fieldsAfterFailure, save: saved });
        expect(fieldsAfterFailure, 'the failed selection leaves no field in the form').toEqual({});
        expect(saved.sent, 'the save request was captured').toBe(true);
        expect(saved.doc, 'the save posts no file').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });

    test('F5 [#B961] an edit form, a slow staging: the delete link clicked during the flight deletes the stored file, and the staging still fills the form', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_AFTER), [{ ok: 'slow.png', delay: SLOW }]);
        await pw.setInputFiles('#docA', file('slow.png'));
        await expect.poll(() => log.stage.length, { timeout: 6000 }).toBe(1);
        await pw.waitForTimeout(300);
        const inFlight = await state(pw);
        expect(inFlight.deleteLinks, 'the stored file\'s link is on the page during the flight').toEqual(['docA-0-delete-trigger']);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        const afterClick = await state(pw);
        const done = await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-slow.png', SLOW + 6000);
        const afterStaging = await state(pw);
        record('F5', log, { inFlight: inFlight, answeredAtRemoval: log.answeredAtRemoval, afterClick: afterClick, stagingFilled: done, afterStaging: afterStaging });
        expect(log.remove, 'the delete request went out').toEqual(['DELETE ']);
        expect(log.answeredAtRemoval, 'while the staging was on the wire').toEqual([0]);
        expect(log.b150, 'no zero-match warning').toEqual([]);
        expect(afterClick.deleteLinks, 'the link went with the file').toEqual([]);
        expect(done, 'the staging still fills the form').toBe(true);
        expect(afterStaging.customFiles, 'the new file is the input\'s entry').toEqual([{ name: 'slow.png', deleteLinkId: null }]);
        expect(log.errors).toEqual([]);
    });

    test('F6 [#B961] an image staged, then a slow staging: its reset clicked during the flight unstages it, and the save posts the new file', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ ok: 'a.png' }, { ok: 'slow.png', delay: SLOW }]);
        expect(await chooseOk(pw, log, 'a.png'), 'the first staging filled the fields').toBe(true);
        await pw.setInputFiles('#docA', file('slow.png'));
        await expect.poll(() => log.stage.length, { timeout: 6000 }).toBe(2);
        await pw.waitForTimeout(300);
        const inFlight = await state(pw);
        expect(inFlight.resetLinkPresent, 'the staged image\'s reset link is on the page during the flight').toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        const done = await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-slow.png', SLOW + 6000);
        const afterStaging = await state(pw);
        const saved = await save(pw, log);
        record('F6', log, { inFlight: inFlight, answeredAtRemoval: log.answeredAtRemoval, stagingFilled: done, afterStaging: afterStaging, save: saved });
        expect(log.remove, 'the reset unstages the staged image').toEqual(['POST {"files":["a.png"]}']);
        expect(log.answeredAtRemoval, 'while the second staging was on the wire').toEqual([1]);
        expect(done, 'the new file\'s fields are filled').toBe(true);
        expect(afterStaging.customFiles, 'the new file is the input\'s entry').toEqual([{ name: 'slow.png', deleteLinkId: null }]);
        expect(saved.sent, 'the save request was captured').toBe(true);
        expect(Array.isArray(saved.doc) && saved.doc.length, 'the save posts one file').toBe(1);
        expect(saved.doc[0].location, 'the new file').toBe('/tmp/uploads/staged-slow.png');
        expect(saved.doc[0].originalFilename).toBe('slow.png');
        expect(log.errors).toEqual([]);
    });

    test('G1 a custom reset trigger is bound by the selection and resets the staged file', async ({ page: pw }) => {
        const log = await open(pw, page(CUSTOM), [{ ok: 'a.png' }]);
        expect(await chooseOk(pw, log, 'a.png'), 'the staging filled the fields').toBe(true);
        const bound = await pw.evaluate(() => document.getElementById('myReset').isBinded === true);
        await pw.click('#myReset');
        await settle(pw, log);
        const afterClick = await state(pw);
        record('G1', log, { customTriggerBound: bound, afterClick: afterClick });
        swapRan(log);
        expect(bound, 'the custom trigger is bound').toBe(true);
        expect(log.remove, 'it unstages the file').toEqual(['POST {"files":["a.png"]}']);
        expect(afterClick.previewNodes, 'the preview went with it').toBe(0);
        expect(await fields(pw), 'and its fields').toEqual({});
        expect(log.errors).toEqual([]);
    });
});
