'use strict';

/**
 * #B1059, #B1057 and #B1058 — a staged file input after a failed staging, after a smaller
 * re-selection, and under its own rules.
 *
 * #B1059: a failed staging dropped the pending selection (#B960) but left the file input holding it,
 * so its value still named the file (`C:\fakepath\<name>`). Choosing that same file again then fired
 * `cancel` instead of `change` in Chromium, and nothing was staged: the user could not retry the file
 * that had failed. Since the fix a failed staging also empties the input's value, so the same file can
 * be chosen again; the files the input already held stay, as #B960 keeps them.
 *
 * #B1057: a staging that succeeds takes the input over (#B960), but the hidden fields of the indices
 * the new selection no longer has stayed in the form: three files staged, then one, and the form
 * posted the new file plus the second and third replaced ones, while the page showed one file. Since
 * the fix those fields go, as a reset takes them out (a locked field stays), and a later, larger
 * selection brings back the ones the page declared.
 *
 * #B1058: a staged file input was collected without a value (#B725), so none of its rules ran:
 * `isRequired` on it let the form be sent with no file. Since the fix an input that has a rule is
 * judged on the files it holds (its entries and a selection still staging), its value never rides the
 * body, and the gate of a live-checked form follows those files (at the selection, the staging settle
 * and a reset).
 *
 *   A1  [#B1059] a failed staging empties the input, and choosing the same file again stages it (CDP)
 *   A2  CONTROL  after a failed staging, choosing another file stages it (both engines, both bundles)
 *   A3  [#B1059] a staged file, a failed staging of a second file, then that second file again (CDP):
 *       the first file stays until the retry succeeds, and the save posts the second file only
 *   A4  [#B1059] a superseded staging empties nothing: the newer selection stays on the input while it
 *       stages, and its own failure empties the input
 *   B1  [#B1057] three files chosen, then one: the save posts the one file (picker)
 *   B2  [#B1057] the same by drop on a dropzone
 *   B3  CONTROL  one file, then three: the save posts the three (both bundles)
 *   B4  [#B1057] three, one, then three again: a field the page declared at index 1 goes and comes back
 *   B5  [#B1057] a locked field at an index the new selection no longer has stays in the form
 *   B6  [#B1057] an edit form showing two saved files, one file chosen: the save posts the new file only
 *   C1  [#B1058] required, no file: the submit is refused and the input is marked invalid
 *   C2  [#B1058] required, a staged file: the first click sends it, with no scalar for the input
 *   C3  optional (`isRequired: false`), no file: the form is sent without the staged input
 *   C4  optional, a staged file: the file rides the body, and no scalar does
 *   C5  [#B1058] required, after a failed staging: the submit is refused
 *   C6  required, an edit form showing a saved file: the first click sends the saved file
 *   C7  [#B1058] required, a click while the file uploads: the submit waits and sends once
 *   C8  [#B1058] required, a staged file then its reset: the trigger is not ready again, the submit refused
 *   C9  CONTROL  no rule on the staged input, no file: the form is sent without it
 *
 * A1 and A3 choose files over CDP (`DOM.setFileInputFiles`), Chromium only: a real re-pick of the same
 * path is the one that fires `cancel`, while Playwright's `setInputFiles` hands the page new files on
 * every call. A WebKit re-pick is not measured here.
 *
 * The staging route answers from each arm's plan, in request order, and never reads the request body
 * (a route handler reads no multipart body on WebKit). A step is `{ ok: <name> }`, `{ fail: true }`
 * (HTTP 500) or `{ cut: true }` (the connection is reset), with an optional `delay` in ms.
 *
 * RED-FIRST: B1057_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves those bytes to every arm
 * (page.route, nothing written to the tree; A2 and B3 assert that the swap ran). On develop
 * `60fa83d78`'s bundle and on the published 0.7.8 bundle, A1, A3, A4 and B1, B2, B4, B5, B6 fail, and
 * A2 and B3 pass. On develop `45a13e465`'s bundle (measured 2026-11-04, Chromium) the same eight fail,
 * and so do C1, C5 and C8, while C2, C3, C4, C6, C7 and C9 pass: with no rule run, every form is sent.
 * On a bundle with the #B1058 change but without the gate re-sync, C2, C7 and C8 fail, each where the
 * trigger stays not ready after the staging or while the file uploads.
 *
 * Run (local; WebKit: GINA_E2E_ENGINES=all ... --project=webkit):
 *   GINA_E2E_PORT=3292 npx playwright test test/e2e/validator-upload-staged-b1057.spec.js --project=chromium --workers=1
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SLOW = 2500;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

/**
 * The head of every page: the stylesheet, an onload whisper and the bundle under test.
 *
 * @param {string} onload - the onload script's path (it carries the forms' rules)
 * @returns {string} the page's head and the opening body tag
 */
function head(onload) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b1057</title>'
        + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="' + onload + '"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>';
}

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

const FORM_OPEN = '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">';
const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

const FRESH = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';
// counts the input's change and cancel events, in the capture phase
const EVENTS = '<script>window.__ev={change:0,cancel:0};(function(){var i=document.getElementById("docA");'
    + 'i.addEventListener("change",function(){window.__ev.change++},true);'
    + 'i.addEventListener("cancel",function(){window.__ev.cancel++},true);}());</script>';

// a multi-file input with a dropzone
const MULTI = '<input id="docA" type="file" name="doc" multiple ' + ACTIONS + ' data-gina-form-upload-dropzone="zoneA">'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'
    + '<div id="zoneA" style="display:block;width:300px;height:80px">drop here</div>';
// declared by the page at index 1, a field the staging answer does not fill
const DECLARED_AT_1 = '<input type="hidden" name="doc[1][caption]" value="">';
// a locked field at index 2
const LOCKED_AT_2 = '<input type="hidden" name="doc[2][tag]" value="keep" data-gina-form-upload-is-locked="true">';
// an edit form showing two saved files, each with its fields and its delete link
const SAVED_TWO = '<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
    + '<input type="hidden" name="doc[0][name]" value="old0.png"><input type="hidden" name="doc[0][location]" value="/media/stored/old0.png">'
    + '<input type="hidden" name="doc[1][name]" value="old1.png"><input type="hidden" name="doc[1][location]" value="/media/stored/old1.png">'
    + '<div id="docA-preview"><img src="/upload-tmp/old0.png" data-upload-original-filename="old0.png" alt="">'
    + '<img src="/upload-tmp/old1.png" data-upload-original-filename="old1.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a> <a href="#" id="docA-1-delete-trigger">Delete</a></div>'
    + '<p id="docA-error" hidden></p>';

// an edit form showing one saved file, with its fields and its delete link
const SAVED_ONE = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<input type="hidden" name="doc[0][name]" value="old.png"><input type="hidden" name="doc[0][location]" value="/media/stored/old.png">'
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';

function page(inner) { return head('/js/gina.onload.b459.js') + FORM_OPEN + inner + FORM_CLOSE + DECLARED + '</body></html>'; }

/**
 * A page whose form keeps the id `b459form` and takes its rules from one of the #B1058 rule sets
 * (`b1058req`: `doc` required; `b1058opt`: `doc` optional), served by `/js/gina.onload.b1058.js`.
 *
 * @param {string} ruleSet - the rule set the form names in `data-gina-form-rule`
 * @param {string} inner - the form's controls after the title
 * @returns {string} the page
 */
function pageRules(ruleSet, inner) {
    return head('/js/gina.onload.b1058.js')
        + '<form id="b459form" data-gina-form-rule="' + ruleSet + '" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">' + inner + FORM_CLOSE + DECLARED + '</body></html>';
}
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
 * read from the request body. A step is `{ ok: <name or names> }`, `{ fail: true }` or
 * `{ cut: true }`, with an optional `delay` in ms. A request the page cancelled while its step
 * waited cannot be answered: that is counted, not thrown.
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
            if (step.delay) { await new Promise((r) => setTimeout(r, step.delay)); }
            if (step.cut) { log.answered++; return await route.abort('connectionreset'); }
            if (step.fail) {
                log.answered++;
                return await route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
                    body: JSON.stringify({ status: 500, error: 'staging refused' }) });
            }
            const names = Array.isArray(step.ok) ? step.ok : [step.ok];
            log.answered++;
            return await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ files: names.map(answer) }) });
        } catch (e) {
            log.unanswerable++;
        }
    };
}

/**
 * Opens a page built from `html` on the runtime server, with the arm's staging plan, and waits for
 * the form to be bound.
 *
 * @param {object} pw - the Playwright page
 * @param {string} html - the page
 * @param {Array<object>} plan - the staging plan (see stager)
 * @returns {Promise<object>} the arm's record
 */
async function open(pw, html, plan) {
    const log = { stage: [], remove: [], saves: [], errors: [], routeHits: 0, answered: 0, unplanned: 0, unanswerable: 0 };
    if (process.env.B1057_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1057_PREFIX_BUNDLE);
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

/** What the page and the input hold for docA. */
function state(pw) {
    return pw.evaluate(() => {
        const $in = document.getElementById('docA');
        const $pv = document.getElementById('docA-preview');
        return {
            value: $in.value,
            events: window.__ev ? Object.assign({}, window.__ev) : null,
            previewSrcs: Array.from($pv.querySelectorAll('img')).map((i) => i.getAttribute('src')),
            resetLinks: Array.from(document.querySelectorAll('[id^="docA-"][id$="-reset-trigger"]')).map((a) => a.id),
            deleteLinks: Array.from(document.querySelectorAll('[id^="docA-"][id$="-delete-trigger"]')).map((a) => a.id),
            customFiles: ($in.customFiles || []).map((f) => f.name),
            pendingFiles: $in.pendingFiles ? $in.pendingFiles.map((f) => f.name) : null
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

/** Waits for the staging error to be shown: true once its text is written. */
function errorShown(pw) {
    return pw.waitForFunction(() => {
        const e = document.getElementById('docA-error');
        return !!(e && e.textContent && e.textContent.length);
    }, null, { timeout: 6000 }).then(() => true, () => false);
}

/** Waits until `count` staging requests went out: false when they did not within `timeout`. */
function staged(log, count, timeout) {
    return expect.poll(() => log.stage.length, { timeout: timeout || 6000 }).toBe(count).then(() => true, () => false);
}

/**
 * Chooses a file over CDP, as a real file picker does: the same path chosen twice is the same file.
 *
 * @param {object} cdp - the page's CDP session (DOM enabled)
 * @param {string} filePath - an absolute path on disk
 * @returns {Promise<void>}
 */
async function cdpPick(cdp, filePath) {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#docA' });
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
}

/**
 * Drops files on zoneA, as a drag from the desktop does (real DataTransfer, real DragEvents).
 *
 * @param {object} pw - the Playwright page
 * @param {Array<string>} names - the dropped files' names
 * @returns {Promise<number>} the count of files the drop carried
 */
function drop(pw, names) {
    return pw.evaluate(({ names, b64 }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        names.forEach((n) => dt.items.add(new File([bytes], n, { type: 'image/png' })));
        const z = document.getElementById('zoneA');
        ['dragenter', 'dragover', 'drop'].forEach((t) => z.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })));
        return dt.files.length;
    }, { names: names, b64: PNG.toString('base64') });
}

/** The indices of the controls in `fieldMap`, sorted, as numbers. */
function indices(fieldMap) {
    return Array.from(new Set(Object.keys(fieldMap).map((n) => Number((n.match(/\[(\d+)\]/) || [])[1])))).sort((a, b) => a - b);
}

/** The original filenames a save posted under `doc`, in order (null for an entry without one). */
function postedNames(saved) {
    return Array.isArray(saved.doc) ? saved.doc.map((d) => (d && d.originalFilename) || null) : saved.doc;
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

/** Whether the submit trigger carries the framework's not-ready mark (#B312), and the file input's aria-invalid. */
function gate(pw) {
    return pw.evaluate(() => ({
        gated: document.getElementById('b459form-submit').getAttribute('data-gina-form-submit-gated'),
        docInvalid: document.getElementById('docA').getAttribute('aria-invalid')
    }));
}

/**
 * Clicks the submit trigger once and waits 1.5 s: the count of save requests that click sent, and
 * the last save body parsed (or as text).
 *
 * @param {object} pw - the Playwright page
 * @param {object} log - the arm's record
 * @returns {Promise<{sent: number, body: *}>}
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

/** What a save body holds under `doc`: '(no doc key)', or the posted value. */
function docOf(body) {
    return (body && typeof body === 'object') ? (('doc' in body) ? body.doc : '(no doc key)') : body;
}

/** The positive control of the red-first seam: the swapped bundle was served. */
function swapRan(log) {
    if (process.env.B1057_PREFIX_BUNDLE) {
        expect(log.routeHits, 'the swapped bundle was served').toBeGreaterThan(0);
    }
}

function record(name, log, extra) {
    const out = Object.assign({ arm: name, bundle: process.env.B1057_PREFIX_BUNDLE ? 'swapped' : 'tree', routeHits: log.routeHits,
        stage: log.stage.length, answered: log.answered, unanswerable: log.unanswerable, removals: log.remove,
        pageErrors: log.errors }, extra || {});
    console.log('B1057-RECORD ' + JSON.stringify(out));
    test.info().annotations.push({ type: 'b1057', description: JSON.stringify(out) });
    expect(log.unplanned, 'every staging request had a planned answer').toBe(0);
}

// the files a CDP pick reads from disk; written once, removed at the end
const TMP = {};
test.beforeAll(() => {
    TMP.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1057-'));
    TMP.a = path.join(TMP.dir, 'a.png');
    TMP.b = path.join(TMP.dir, 'b.png');
    fs.writeFileSync(TMP.a, PNG);
    fs.writeFileSync(TMP.b, PNG);
});
test.afterAll(() => {
    if (TMP.dir) { fs.rmSync(TMP.dir, { recursive: true, force: true }); }
});

test.describe('#B1059 - a failed staging empties the file input', () => {

    test('A1 a failed staging empties the input, and choosing the same file again stages it', async ({ page: pw }, ti) => {
        test.skip(ti.project.name !== 'chromium', 'a same-file re-pick goes through CDP (DOM.setFileInputFiles)');
        const log = await open(pw, page(FRESH + EVENTS), [{ fail: true }, { ok: 'a.png' }]);
        const cdp = await pw.context().newCDPSession(pw);
        await cdp.send('DOM.enable');
        await cdpPick(cdp, TMP.a);
        const shown = await errorShown(pw);
        await pw.waitForTimeout(300);
        const afterFailure = await state(pw);
        await cdpPick(cdp, TMP.a);
        const restaged = await staged(log, 2, 3000);
        const done = restaged && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const afterRetry = await state(pw);
        record('A1', log, { errorShown: shown, afterFailure: afterFailure, restaged: restaged, filled: done, afterRetry: afterRetry });
        swapRan(log);
        expect(shown, 'the staging error is shown').toBe(true);
        expect(afterFailure.value, 'the failed selection is gone from the input').toBe('');
        expect(restaged, 'choosing the same file again sends it').toBe(true);
        expect(done, 'and its answer fills the form').toBe(true);
        expect(afterRetry.events, 'both choices fired change, none cancel').toEqual({ change: 2, cancel: 0 });
        expect(afterRetry.customFiles, 'the file is the input\'s entry').toEqual(['a.png']);
        expect(log.errors).toEqual([]);
    });

    test('A2 CONTROL - after a failed staging, choosing another file stages it', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ fail: true }, { ok: 'b.png' }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const shown = await errorShown(pw);
        await pw.waitForTimeout(300);
        await pw.setInputFiles('#docA', file('b.png'));
        const sent = await staged(log, 2);
        const done = sent && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-b.png');
        const after = await state(pw);
        record('A2', log, { errorShown: shown, sent: sent, filled: done, after: after });
        swapRan(log);
        expect(shown, 'the staging error is shown').toBe(true);
        expect(sent, 'the other file is sent').toBe(true);
        expect(done, 'and its answer fills the form').toBe(true);
        expect(after.customFiles).toEqual(['b.png']);
        expect(log.errors).toEqual([]);
    });

    test('A3 a staged file, a failed staging of a second file, then that file again: the first stays until the retry succeeds', async ({ page: pw }, ti) => {
        test.skip(ti.project.name !== 'chromium', 'a same-file re-pick goes through CDP (DOM.setFileInputFiles)');
        const log = await open(pw, page(FRESH + EVENTS), [{ ok: 'a.png' }, { fail: true }, { ok: 'b.png' }]);
        const cdp = await pw.context().newCDPSession(pw);
        await cdp.send('DOM.enable');
        await cdpPick(cdp, TMP.a);
        const first = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        await cdpPick(cdp, TMP.b);
        const shown = await errorShown(pw);
        await pw.waitForTimeout(300);
        const afterFailure = await state(pw);
        const fieldsAfterFailure = await fields(pw);
        await cdpPick(cdp, TMP.b);
        const restaged = await staged(log, 3, 3000);
        const done = restaged && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-b.png');
        const afterRetry = await state(pw);
        const saved = await save(pw, log);
        record('A3', log, { first: first, errorShown: shown, afterFailure: afterFailure, fieldsAfterFailure: fieldsAfterFailure,
            restaged: restaged, filled: done, afterRetry: afterRetry, save: saved });
        expect(first, 'the first file is staged').toBe(true);
        expect(shown, 'the second staging error is shown').toBe(true);
        expect(afterFailure.previewSrcs, 'the first file\'s preview stays').toEqual(['/upload-tmp/staged-a.png']);
        expect(afterFailure.customFiles, 'its entry stays').toEqual(['a.png']);
        expect(fieldsAfterFailure['doc[0][location]'], 'its fields stay').toBe('/tmp/uploads/staged-a.png');
        expect(afterFailure.value, 'the failed selection is gone from the input').toBe('');
        expect(restaged, 'choosing the second file again sends it').toBe(true);
        expect(done, 'and its answer fills the form').toBe(true);
        expect(afterRetry.customFiles, 'the second file takes the input over').toEqual(['b.png']);
        expect(saved.sent, 'the save request was captured').toBe(true);
        expect(Array.isArray(saved.doc) && saved.doc.map((d) => d && d.originalFilename), 'the save posts the second file only').toEqual(['b.png']);
        expect(log.errors).toEqual([]);
    });

    test('A4 a superseded staging empties nothing, and the newer selection\'s failure empties the input', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ ok: 'a.png', delay: SLOW }, { fail: true, delay: 600 }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const firstSent = await staged(log, 1);
        await pw.waitForTimeout(300);
        await pw.setInputFiles('#docA', file('b.png'));
        const secondSent = await staged(log, 2);
        const inFlight = await state(pw);
        const shown = await errorShown(pw);
        await pw.waitForTimeout(300);
        const afterFailure = await state(pw);
        // the superseded staging's answer was due SLOW ms after its request
        await pw.waitForTimeout(SLOW);
        const afterSupersededAnswer = await state(pw);
        const fieldsAtEnd = await fields(pw);
        record('A4', log, { firstSent: firstSent, secondSent: secondSent, inFlight: inFlight, errorShown: shown,
            afterFailure: afterFailure, afterSupersededAnswer: afterSupersededAnswer, fieldsAtEnd: fieldsAtEnd });
        expect(firstSent && secondSent, 'both selections were sent').toBe(true);
        expect(inFlight.value, 'the newer selection stays on the input while it stages').toMatch(/b\.png$/);
        expect(inFlight.pendingFiles, 'it is the pending selection').toEqual(['b.png']);
        expect(shown, 'its staging error is shown').toBe(true);
        expect(afterFailure.value, 'its failure empties the input').toBe('');
        expect(afterSupersededAnswer.value, 'and the superseded staging empties nothing more').toBe('');
        expect(afterSupersededAnswer.customFiles, 'nor takes the input over').toEqual([]);
        expect(fieldsAtEnd, 'no field was written').toEqual({});
        expect(log.errors).toEqual([]);
    });
});

test.describe('#B1057 - a smaller selection takes out the fields of the files it replaced', () => {

    /**
     * Chooses three files, then one, through `choose` (the picker or a drop), and saves.
     *
     * @param {object} pw - the Playwright page
     * @param {Function} choose - (names) => Promise, one selection
     * @returns {Promise<object>} the readings
     */
    async function threeThenOne(pw, choose) {
        const log = await open(pw, page(MULTI), [{ ok: ['a.png', 'b.png', 'c.png'] }, { ok: 'd.png' }]);
        await choose(['a.png', 'b.png', 'c.png']);
        const three = await staged(log, 1) && await filled(pw, 'doc[2][location]', '/tmp/uploads/staged-c.png');
        await choose(['d.png']);
        const one = await staged(log, 2) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-d.png');
        await pw.waitForTimeout(200);
        const after = await state(pw);
        const fieldsAfter = await fields(pw);
        const saved = await save(pw, log);
        return { log: log, three: three, one: one, after: after, fieldsAfter: fieldsAfter, saved: saved };
    }

    function assertThreeThenOne(r) {
        expect(r.three && r.one, 'both stagings filled the form').toBe(true);
        expect(r.after.customFiles, 'the input holds the one file').toEqual(['d.png']);
        expect(r.after.previewSrcs, 'the page shows the one file').toEqual(['/upload-tmp/staged-d.png']);
        expect(r.after.resetLinks, 'with one reset link').toEqual(['docA-0-reset-trigger']);
        expect(indices(r.fieldsAfter), 'only index 0 has fields').toEqual([0]);
        expect(r.saved.sent, 'the save request was captured').toBe(true);
        expect(postedNames(r.saved), 'the save posts the one file').toEqual(['d.png']);
        expect(r.log.remove, 'no removal request: a replaced staged file is not unstaged').toEqual([]);
        expect(r.log.errors).toEqual([]);
    }

    test('B1 three files chosen, then one: the save posts the one file (picker)', async ({ page: pw }) => {
        const r = await threeThenOne(pw, (names) => pw.setInputFiles('#docA', names.map(file)));
        record('B1', r.log, { three: r.three, one: r.one, after: r.after, fieldIndices: indices(r.fieldsAfter), save: postedNames(r.saved) });
        assertThreeThenOne(r);
    });

    test('B2 three files dropped, then one: the save posts the one file (dropzone)', async ({ page: pw }) => {
        const r = await threeThenOne(pw, (names) => drop(pw, names));
        record('B2', r.log, { three: r.three, one: r.one, after: r.after, fieldIndices: indices(r.fieldsAfter), save: postedNames(r.saved) });
        assertThreeThenOne(r);
    });

    test('B3 CONTROL - one file, then three: the save posts the three', async ({ page: pw }) => {
        const log = await open(pw, page(MULTI), [{ ok: 'a.png' }, { ok: ['b.png', 'c.png', 'd.png'] }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const one = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        await pw.setInputFiles('#docA', ['b.png', 'c.png', 'd.png'].map(file));
        const three = await staged(log, 2) && await filled(pw, 'doc[2][location]', '/tmp/uploads/staged-d.png');
        const fieldsAfter = await fields(pw);
        const saved = await save(pw, log);
        record('B3', log, { one: one, three: three, fieldIndices: indices(fieldsAfter), save: postedNames(saved) });
        swapRan(log);
        expect(one && three, 'both stagings filled the form').toBe(true);
        expect(indices(fieldsAfter)).toEqual([0, 1, 2]);
        expect(postedNames(saved), 'the save posts the three files').toEqual(['b.png', 'c.png', 'd.png']);
        expect(log.errors).toEqual([]);
    });

    test('B4 three, one, then three again: a field the page declared at index 1 goes, then comes back', async ({ page: pw }) => {
        const log = await open(pw, page(MULTI + DECLARED_AT_1), [{ ok: ['a.png', 'b.png', 'c.png'] }, { ok: 'd.png' }, { ok: ['e.png', 'f.png', 'g.png'] }]);
        await pw.setInputFiles('#docA', ['a.png', 'b.png', 'c.png'].map(file));
        const first = await staged(log, 1) && await filled(pw, 'doc[2][location]', '/tmp/uploads/staged-c.png');
        const fieldsAfterThree = await fields(pw);
        await pw.setInputFiles('#docA', file('d.png'));
        const second = await staged(log, 2) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-d.png');
        await pw.waitForTimeout(200);
        const fieldsAfterOne = await fields(pw);
        await pw.setInputFiles('#docA', ['e.png', 'f.png', 'g.png'].map(file));
        const third = await staged(log, 3) && await filled(pw, 'doc[2][location]', '/tmp/uploads/staged-g.png');
        const fieldsAfterThreeAgain = await fields(pw);
        const saved = await save(pw, log);
        record('B4', log, { first: first, second: second, third: third, afterThree: 'doc[1][caption]' in fieldsAfterThree,
            afterOne: indices(fieldsAfterOne), afterOneCaption: 'doc[1][caption]' in fieldsAfterOne,
            afterThreeAgain: indices(fieldsAfterThreeAgain), afterThreeAgainCaption: fieldsAfterThreeAgain['doc[1][caption]'], save: postedNames(saved) });
        expect(first && second && third, 'the three stagings filled the form').toBe(true);
        expect('doc[1][caption]' in fieldsAfterThree, 'the declared field is in the form').toBe(true);
        expect(indices(fieldsAfterOne), 'after one file, only index 0 has fields').toEqual([0]);
        expect('doc[1][caption]' in fieldsAfterOne, 'the declared field went with index 1').toBe(false);
        expect(fieldsAfterThreeAgain['doc[1][caption]'], 'it comes back, empty, with the next file at index 1').toBe('');
        expect(postedNames(saved), 'the save posts the last three files').toEqual(['e.png', 'f.png', 'g.png']);
        expect(log.errors).toEqual([]);
    });

    test('B5 a locked field at an index the new selection no longer has stays in the form', async ({ page: pw }) => {
        const log = await open(pw, page(MULTI + LOCKED_AT_2), [{ ok: ['a.png', 'b.png', 'c.png'] }, { ok: 'd.png' }]);
        await pw.setInputFiles('#docA', ['a.png', 'b.png', 'c.png'].map(file));
        const three = await staged(log, 1) && await filled(pw, 'doc[2][location]', '/tmp/uploads/staged-c.png');
        await pw.setInputFiles('#docA', file('d.png'));
        const one = await staged(log, 2) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-d.png');
        await pw.waitForTimeout(200);
        const fieldsAfter = await fields(pw);
        const stale = Object.keys(fieldsAfter).filter((n) => /^doc\[[12]\]/.test(n));
        record('B5', log, { three: three, one: one, stale: stale, locked: fieldsAfter['doc[2][tag]'] });
        expect(three && one, 'both stagings filled the form').toBe(true);
        expect(fieldsAfter['doc[2][tag]'], 'the locked field stays, with its value').toBe('keep');
        expect(stale, 'and is the only field left at indices 1 and 2').toEqual(['doc[2][tag]']);
        expect(log.errors).toEqual([]);
    });

    test('B6 an edit form showing two saved files, one file chosen: the save posts the new file only', async ({ page: pw }) => {
        const log = await open(pw, page(SAVED_TWO), [{ ok: 'd.png' }]);
        const before = await state(pw);
        await pw.setInputFiles('#docA', file('d.png'));
        const one = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-d.png');
        await pw.waitForTimeout(200);
        const after = await state(pw);
        const fieldsAfter = await fields(pw);
        const saved = await save(pw, log);
        record('B6', log, { before: before, one: one, after: after, fieldIndices: indices(fieldsAfter),
            save: Array.isArray(saved.doc) ? saved.doc.map((d) => d && d.location) : saved.doc });
        expect(before.customFiles, 'the two saved files are the input\'s entries').toEqual(['old0.png', 'old1.png']);
        expect(one, 'the staging filled the form').toBe(true);
        expect(after.deleteLinks, 'both saved files\' delete links went (#B150)').toEqual([]);
        expect(after.customFiles, 'the new file takes the input over').toEqual(['d.png']);
        expect(indices(fieldsAfter), 'only index 0 has fields').toEqual([0]);
        expect(Array.isArray(saved.doc) ? saved.doc.map((d) => d && d.location) : saved.doc, 'the save posts the new file only')
            .toEqual(['/tmp/uploads/staged-d.png']);
        expect(log.remove, 'no removal request').toEqual([]);
        expect(log.errors).toEqual([]);
    });
});

test.describe('#B1058 - a rule on a staged file input judges the files it holds', () => {

    test('C1 required, no file: the submit is refused and the input is marked invalid', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', FRESH), []);
        const atBind = await gate(pw);
        const click = await clickOnce(pw, log);
        const after = await gate(pw);
        record('C1', log, { atBind: atBind, sent: click.sent, after: after });
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('C2 required, a staged file: the first click sends the file, and no scalar rides the body', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', FRESH), [{ ok: 'a.png' }]);
        const atBind = await gate(pw);
        await pw.setInputFiles('#docA', file('a.png'));
        const done = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const afterStaging = await gate(pw);
        const click = await clickOnce(pw, log);
        record('C2', log, { atBind: atBind, filled: done, afterStaging: afterStaging, sent: click.sent, doc: docOf(click.body) });
        expect(done, 'the staging filled the form').toBe(true);
        expect(afterStaging.gated, 'the staged file opens the submit trigger').toBe(null);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(Array.isArray(docOf(click.body)) && docOf(click.body).map((d) => d && d.originalFilename), 'the staged file rides the body').toEqual(['a.png']);
        expect(click.raw, 'the input\'s own value is not posted').not.toContain('fakepath');
        expect(click.raw, 'no scalar for the staged input').not.toContain('"doc":"');
        expect(log.errors).toEqual([]);
    });

    test('C3 optional, no file: the form is sent without the staged input', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058opt', FRESH), []);
        const click = await clickOnce(pw, log);
        record('C3', log, { sent: click.sent, doc: docOf(click.body) });
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });

    test('C4 optional, a staged file: the file rides the body, and no scalar does', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058opt', FRESH), [{ ok: 'a.png' }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const done = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const click = await clickOnce(pw, log);
        record('C4', log, { filled: done, sent: click.sent, doc: docOf(click.body) });
        expect(done).toBe(true);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(Array.isArray(docOf(click.body)) && docOf(click.body).map((d) => d && d.originalFilename)).toEqual(['a.png']);
        expect(click.raw, 'no scalar for the staged input').not.toContain('"doc":"');
        expect(log.errors).toEqual([]);
    });

    test('C5 required, after a failed staging: the submit is refused', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', FRESH), [{ fail: true }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const shown = await errorShown(pw);
        await pw.waitForTimeout(300);
        const afterFailure = await gate(pw);
        const click = await clickOnce(pw, log);
        const after = await gate(pw);
        record('C5', log, { errorShown: shown, afterFailure: afterFailure, sent: click.sent, after: after });
        expect(shown, 'the staging error is shown').toBe(true);
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('C6 required, an edit form showing a saved file: the first click sends the saved file', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', SAVED_ONE), []);
        const atBind = await gate(pw);
        const click = await clickOnce(pw, log);
        record('C6', log, { atBind: atBind, sent: click.sent, doc: docOf(click.body) });
        expect(atBind.gated, 'the saved file satisfies the rule at bind').toBe(null);
        expect(click.sent, 'the first click sends').toBe(1);
        expect(docOf(click.body), 'the saved file\'s fields ride the body').toEqual([{ name: 'old.png', location: '/media/stored/old.png' }]);
        expect(log.errors).toEqual([]);
    });

    test('C7 required, a click while the file uploads: the submit waits and sends once', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', FRESH), [{ ok: 'a.png', delay: 1500 }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const sent = await staged(log, 1);
        await pw.waitForTimeout(300);
        const inFlight = await gate(pw);
        await pw.click('#b459form-submit', { force: true });
        await pw.waitForTimeout(400);
        const savesDuringFlight = log.saves.length;
        const done = await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png', 6000);
        await expect.poll(() => log.saves.length, { timeout: 6000 }).toBe(1).catch(() => {});
        await pw.waitForTimeout(500);
        let body = log.saves.length ? log.saves[log.saves.length - 1] : null;
        try { body = JSON.parse(body); } catch (e) { /* kept as text */ }
        record('C7', log, { sent: sent, inFlight: inFlight, savesDuringFlight: savesDuringFlight, filled: done, saves: log.saves.length, doc: docOf(body) });
        expect(sent, 'the file is sent for staging').toBe(true);
        expect(inFlight.gated, 'the file in flight opens the submit trigger').toBe(null);
        expect(savesDuringFlight, 'nothing is sent while the file uploads').toBe(0);
        expect(done, 'the staging fills the form').toBe(true);
        expect(log.saves.length, 'the waiting submit sends once').toBe(1);
        expect(Array.isArray(docOf(body)) && docOf(body).map((d) => d && d.originalFilename)).toEqual(['a.png']);
        expect(log.errors).toEqual([]);
    });

    test('C8 required, a staged file then its reset: the trigger is marked not ready again and the submit is refused', async ({ page: pw }) => {
        const log = await open(pw, pageRules('b1058req', FRESH), [{ ok: 'a.png' }]);
        await pw.setInputFiles('#docA', file('a.png'));
        const done = await staged(log, 1) && await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-a.png');
        const afterStaging = await gate(pw);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length, { timeout: 4000 }).toBe(1).catch(() => {});
        await pw.waitForTimeout(300);
        const afterReset = await gate(pw);
        const click = await clickOnce(pw, log);
        const after = await gate(pw);
        record('C8', log, { filled: done, afterStaging: afterStaging, afterReset: afterReset, sent: click.sent, after: after });
        expect(done).toBe(true);
        expect(afterStaging.gated, 'the staged file opens the trigger').toBe(null);
        expect(log.remove, 'the reset unstages the file').toEqual(['POST {"files":["a.png"]}']);
        expect(afterReset.gated, 'the reset marks the trigger not ready again').toBe('true');
        expect(click.sent, 'nothing is sent').toBe(0);
        expect(after.docInvalid, 'the staged input is marked invalid').toBe('true');
        expect(log.errors).toEqual([]);
    });

    test('C9 CONTROL - no rule on the staged input, no file: the form is sent without it', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), []);
        const click = await clickOnce(pw, log);
        record('C9', log, { sent: click.sent, doc: docOf(click.body) });
        swapRan(log);
        expect(click.sent, 'the form is sent').toBe(1);
        expect(docOf(click.body), 'with no doc key').toBe('(no doc key)');
        expect(log.errors).toEqual([]);
    });
});
