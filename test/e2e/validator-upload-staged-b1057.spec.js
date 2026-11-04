'use strict';

/**
 * #B1059 — a staged file input after a failed staging.
 *
 * #B1059: a failed staging dropped the pending selection (#B960) but left the file input holding it,
 * so its value still named the file (`C:\fakepath\<name>`). Choosing that same file again then fired
 * `cancel` instead of `change` in Chromium, and nothing was staged: the user could not retry the file
 * that had failed. Since the fix a failed staging also empties the input's value, so the same file can
 * be chosen again; the files the input already held stay, as #B960 keeps them.
 *
 *   A1  [#B1059] a failed staging empties the input, and choosing the same file again stages it (CDP)
 *   A2  CONTROL  after a failed staging, choosing another file stages it (both engines, both bundles)
 *   A3  [#B1059] a staged file, a failed staging of a second file, then that second file again (CDP):
 *       the first file stays until the retry succeeds, and the save posts the second file only
 *   A4  [#B1059] a superseded staging empties nothing: the newer selection stays on the input while it
 *       stages, and its own failure empties the input
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
 * (page.route, nothing written to the tree; A2 asserts that the swap ran). On develop `60fa83d78`'s
 * bundle and on the published 0.7.8 bundle, A1, A3 and A4 fail and A2 passes.
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

function page(inner) { return head('/js/gina.onload.b459.js') + FORM_OPEN + inner + FORM_CLOSE + DECLARED + '</body></html>'; }
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
