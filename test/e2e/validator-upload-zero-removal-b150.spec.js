'use strict';

/**
 * #B150 — a reproduction attempt: can a reset or a delete through the framework's own link remove
 * nothing (no removal request, the #B150 warning) in a real flow?
 *
 * The report (2026-07-23) came from a hand-injected container bound at runtime; on the code of the
 * time the removal loop walked the preview's <img> nodes and matched each one by name against the
 * input's files. #B859 (0.7.4, `369b5df62`) replaced that loop with a pass over the input's files by index, so
 * a reset or a delete removes nothing only when the input holds no file to remove while the
 * preview shows file nodes — the state the #B150 warning reports.
 *
 * Each arm records the requests to the removal action and the #B150 warnings; the real-flow arms
 * expect one request and no warning. C1 is the positive control of the instrument: it empties the
 * input's file list before the reset, so the warning MUST fire and no request may leave.
 * O2 is an observation arm: it records what happens and asserts only the instrument.
 *
 * REPRODUCED, then FIXED (#B150): an edit form whose stored file's delete link sits after the
 * preview container (the shape the uploads guide documents). A selection replaces the stored
 * entry: the container reset of the staging success took a link placed inside the container,
 * never one placed after it, which stayed on the page, bound to an entry the input no longer
 * held — a click sent nothing, removed nothing, and logged the warning. Since the fix the change
 * listener keeps the replaced entries on the input and the staging success removes their links.
 *   F1 [fix] one stored file, a new file chosen: the delete link is gone at staging success
 *   F2 [fix] two stored files: both links go
 *   F3 [fix] a failed staging keeps the link; the next successful selection removes it
 *   O1C CONTROL the same page, no new file: the link deletes the stored file
 *   O4 OBSERVE an empty selection (the picker cancelled) after a stored file, then its link
 *
 * FIXED (#B959): a change that carries no file (an emptied selection) emptied the input's entries
 * before the listener's early return, so the links of the files already shown removed nothing and
 * logged the warning. Since the fix the return comes first.
 *   F4 [fix, #B959] an empty selection after a stored file: the entry stays, its link deletes it
 *   F5 [fix, #B959] an empty selection after a staged file: the entry stays, its link resets it
 *
 * RED-FIRST: B150_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves the old bytes to every
 * arm (page.route, nothing written to disk; `routeHits` proves they ran). A bundle without either
 * fix fails F1-F5, one with #B150 only fails F4 and F5, each on its own assertion; every other arm
 * passes.
 *
 * Run (local, cached headless shell):
 *   GINA_E2E_PORT=3191 PW_CHROME=<chrome-headless-shell> npx playwright test \
 *     test/e2e/validator-upload-zero-removal-b150.spec.js --project=chromium
 */

const { test, expect } = require('@playwright/test');
// WebKit hands Playwright no body for gina's Blob staging request, so a mock reading the staged
// file names from it would answer "no files" there: copy each Blob body into a header that
// requestBody() falls back to (helpers/request-body.js, #B996).
const { copyBlobBodies, requestBody } = require('./helpers/request-body');
test.beforeEach(async ({ context }) => { await context.addInitScript(copyBlobBodies); });

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
const B150 = /preview\(s\) present but none matched/;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b150</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

function file(name) {
    return /pdf$/.test(name)
        ? { name: name, mimeType: 'application/pdf', buffer: PDF }
        : { name: name, mimeType: 'image/png', buffer: PNG };
}
function base(name) { return name.replace(/\.[^.]+$/, ''); }
function preview(name) {
    return { originalFilename: 'staged-' + base(name) + '-preview.png', location: '/tmp/uploads/staged-' + base(name) + '-preview.png',
        uri: '/media/previews/staged-' + base(name) + '-preview.png', tmpUri: '/upload-tmp/staged-' + base(name) + '-preview.png', width: 1, height: 1 };
}
const ANSWERS = {
    image: (name) => ({ name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-' + name, mime: 'image/png', tmpUri: '/upload-tmp/staged-' + name }),
    pdf: (name) => ({ name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'pdf', encoding: '7bit',
        size: 44, location: '/tmp/uploads/staged-' + name, mime: 'application/pdf', tmpUri: '/upload-tmp/staged-' + name }),
    pdfWithPreview: (name) => Object.assign(ANSWERS.pdf(name), { preview: preview(name) })
};

const FORM_OPEN = '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">';
const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

function page(inner) { return HEAD + FORM_OPEN + inner + FORM_CLOSE + DECLARED + '</body></html>'; }

async function open(pw, html, answer, extraRoutes) {
    const log = { stage: [], remove: [], b150: [], errors: [], routeHits: 0 };
    if (process.env.B150_PREFIX_BUNDLE) {
        const body = require('fs').readFileSync(process.env.B150_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    if (answer) {
        await pw.route('**/upload-stage', async (route) => {
            const s = (requestBody(route.request()) || Buffer.alloc(0)).toString('latin1');
            const names = [];
            const re = /filename="([^"]+)"/g;
            let m;
            while ((m = re.exec(s))) { names.push(m[1]); }
            await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ files: names.map(ANSWERS[answer]) }) });
        });
    }
    for (const [glob, fn] of (extraRoutes || [])) { await pw.route(glob, fn); }
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('console', (m) => { if (m.type() === 'warning' && B150.test(m.text())) { log.b150.push(m.text()); } });
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage.push(r.method()); }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    return log;
}

function ready(pw, formIds) {
    return pw.waitForFunction((ids) => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && ids.every((id) => !!window.gina.validator.$forms[id])), formIds || ['b459form', 'b459declared'], { timeout: 15000 });
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

function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

async function select(pw, log, names) {
    const before = log.stage.length;
    const files = names.map(file);
    await pw.setInputFiles('#docA', files.length > 1 ? files : files[0]);
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    return filled(pw, 'doc[0][location]', '/tmp/uploads/staged-' + names[0]);
}

/** Waits for a removal request, or 800 ms when none comes. */
async function settle(pw, log) {
    await expect.poll(() => log.remove.length, { timeout: 2500 }).toBeGreaterThan(0).catch(() => {});
    await pw.waitForTimeout(300);
}

function record(name, log, extra) {
    const out = Object.assign({ arm: name, bundle: process.env.B150_PREFIX_BUNDLE ? 'swapped' : 'tree', routeHits: log.routeHits,
        removals: log.remove, b150Warnings: log.b150.length, pageErrors: log.errors }, extra || {});
    console.log('B150-RECORD ' + JSON.stringify(out));
    test.info().annotations.push({ type: 'b150', description: JSON.stringify(out) });
}

test.describe('#B150 reproduction attempt — a reset or a delete that removes nothing', () => {

    test('R1 an image staged, then reset through the framework link', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        record('R1', log);
        expect(log.remove).toEqual(['POST {"files":["me.png"]}']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('R2 a PDF with a preview staged, then reset', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'pdfWithPreview');
        await ready(pw);
        expect(await select(pw, log, ['report.pdf'])).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        record('R2', log);
        expect(log.remove).toEqual(['POST {"files":["report.pdf","staged-report-preview.png"]}']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('R3 two images staged on a multiple input, then reset', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png', 'you.png'])).toBe(true);
        expect(await filled(pw, 'doc[1][location]', '/tmp/uploads/staged-you.png')).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        record('R3', log);
        expect(log.remove).toEqual(['POST {"files":["me.png","you.png"]}']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('R4 an edit form: a stored image rendered by the server, deleted through its link', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="photo.png"><input type="hidden" name="doc[0][location]" value="/media/stored/photo.png">'
            + '<div id="docA-preview"><img src="/upload-tmp/photo.png" data-upload-original-filename="photo.png" alt=""><a href="#" id="docA-0-delete-trigger">Delete</a></div>'
            + '<p id="docA-error" hidden></p>'), null);
        await ready(pw);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        record('R4', log);
        expect(log.remove).toEqual(['DELETE ']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('R5 inside a popin: an image staged, then reset', async ({ page: pw }) => {
        const PAGE = HEAD + '<h1>p</h1><button data-gina-popin-name="upl" data-gina-popin-url="/frag/upl.html" data-gina-dialog-preload="false">Open</button></body></html>';
        const FRAG = '<div id="upl-frag">' + FORM_OPEN
            + '<input id="docA" type="file" name="doc" ' + ACTIONS + ' data-gina-form-upload-preview="docA-preview">'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>' + FORM_CLOSE
            + '<button class="gina-popin-close" type="button">Close</button></div>';
        const log = await open(pw, PAGE, 'image', [['**/frag/upl.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAG })]]);
        await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && window.gina.validator), null, { timeout: 15000 });
        const reg = await pw.evaluate(() => new Promise((resolve) => {
            setTimeout(() => resolve('TIMEOUT'), 8000);
            window.require(['gina/popin'], function (Popin) { new Popin({ name: 'upl', validator: window.gina.validator }).on('ready', function () { resolve('READY'); }); });
        }));
        expect(reg).toBe('READY');
        await pw.click('[data-gina-popin-name="upl"]');
        await pw.waitForFunction(() => { const p = window.gina.popin.getPopinByName('upl'); const f = document.getElementById('b459form'); return !!(p && p.isOpen && f && f.closest('dialog')); }, null, { timeout: 8000 });
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.click('#docA-0-reset-trigger', { force: true });
        await settle(pw, log);
        record('R5', log);
        expect(log.remove).toEqual(['POST {"files":["me.png"]}']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('C1 CONTROL — the input holds no file at the reset: the #B150 warning fires and nothing is sent', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.evaluate(() => { document.getElementById('docA').customFiles = []; });
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        record('C1', log);
        expect(log.b150.length, 'the warning fired').toBe(1);
        expect(log.remove, 'no removal request').toEqual([]);
    });

    const EDIT_ONE = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
        + '<input type="hidden" name="doc[0][name]" value="old.png"><input type="hidden" name="doc[0][location]" value="/media/stored/old.png">'
        + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
        + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';

    /** What the page holds for docA: the links, the preview nodes, the input's entries. */
    function state(pw) {
        return pw.evaluate(() => ({
            deleteLinks: ['docA-0-delete-trigger', 'docA-1-delete-trigger'].filter((id) => !!document.getElementById(id)),
            resetLinkPresent: !!document.getElementById('docA-0-reset-trigger'),
            previewNodes: document.getElementById('docA-preview').querySelectorAll('img,[data-upload-original-filename]').length,
            customFiles: (document.getElementById('docA').customFiles || []).map((f) => ({ name: f.name, deleteLinkId: f.deleteLinkId || null }))
        }));
    }

    test('F1 [fix] an edit form: a new file replaces the stored file, whose delete link (after the container) is removed at staging success', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_ONE), 'image');
        await ready(pw);
        expect(await pw.evaluate(() => document.getElementById('docA-0-delete-trigger').isBinded === true), 'the delete link is bound').toBe(true);
        expect(await select(pw, log, ['new.png'])).toBe(true);
        const s = await state(pw);
        record('F1', log, { after: s });
        expect(s.deleteLinks, 'the replaced file\'s delete link is gone').toEqual([]);
        expect(s.resetLinkPresent, 'the staged file has its reset link').toBe(true);
        expect(s.customFiles).toEqual([{ name: 'new.png', deleteLinkId: null }]);
        expect((await fields(pw))['doc[0][location]']).toBe('/tmp/uploads/staged-new.png');
        expect(log.remove).toEqual([]);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F2 [fix] two stored files, both links after the container: one new file replaces them and both links go', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="one.png"><input type="hidden" name="doc[0][location]" value="/media/stored/one.png">'
            + '<input type="hidden" name="doc[1][name]" value="two.png"><input type="hidden" name="doc[1][location]" value="/media/stored/two.png">'
            + '<div id="docA-preview"><img src="/upload-tmp/one.png" alt=""><img src="/upload-tmp/two.png" alt=""></div>'
            + '<div><a href="#" id="docA-0-delete-trigger">Delete 1</a> <a href="#" id="docA-1-delete-trigger">Delete 2</a></div>'
            + '<p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect((await state(pw)).deleteLinks).toEqual(['docA-0-delete-trigger', 'docA-1-delete-trigger']);
        expect(await select(pw, log, ['new.png'])).toBe(true);
        const s = await state(pw);
        record('F2', log, { after: s });
        expect(s.deleteLinks, 'both replaced files\' delete links are gone').toEqual([]);
        expect(s.customFiles).toEqual([{ name: 'new.png', deleteLinkId: null }]);
        expect(log.remove).toEqual([]);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F3 [fix] a failed staging keeps the stored file\'s link; the next successful selection removes it', async ({ page: pw }) => {
        let stagings = 0;
        const log = await open(pw, page(EDIT_ONE), null, [['**/upload-stage', async (route) => {
            stagings++;
            if (stagings === 1) {
                return route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ status: 500, error: 'staging refused' }) });
            }
            const s = (requestBody(route.request()) || Buffer.alloc(0)).toString('latin1');
            const names = []; const re = /filename="([^"]+)"/g; let m;
            while ((m = re.exec(s))) { names.push(m[1]); }
            await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ files: names.map(ANSWERS.image) }) });
        }]]);
        await ready(pw);
        await pw.setInputFiles('#docA', file('first.png'));
        await expect.poll(() => log.stage.length, { timeout: 6000 }).toBe(1);
        await pw.waitForTimeout(400);
        const afterFailure = await state(pw);
        expect(afterFailure.deleteLinks, 'the stored file\'s link stays after a failed staging').toEqual(['docA-0-delete-trigger']);
        expect(await select(pw, log, ['second.png']), 'the second selection staged').toBe(true);
        const s = await state(pw);
        record('F3', log, { afterFailure: afterFailure, after: s, stagings: stagings });
        expect(s.deleteLinks, 'the replaced file\'s link is gone after the successful staging').toEqual([]);
        expect(s.customFiles).toEqual([{ name: 'second.png', deleteLinkId: null }]);
        expect(log.remove).toEqual([]);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F4 [fix, #B959] an empty selection after a stored file leaves its entry: the delete link still deletes it', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_ONE), 'image');
        await ready(pw);
        await pw.setInputFiles('#docA', []);
        await pw.waitForTimeout(400);
        const afterEmpty = await state(pw);
        expect(afterEmpty.deleteLinks, 'the stored file\'s link stays').toEqual(['docA-0-delete-trigger']);
        expect(afterEmpty.customFiles, 'the stored entry stays on the input').toEqual([{ name: 'old.png', deleteLinkId: 'docA-0-delete-trigger' }]);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        const after = await state(pw);
        record('F4', log, { afterEmpty: afterEmpty, after: after });
        expect(log.remove, 'the delete request went out').toEqual(['DELETE ']);
        expect(after.deleteLinks, 'the link went with the file').toEqual([]);
        expect(log.stage, 'the empty selection staged nothing').toEqual([]);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('F5 [fix, #B959] an empty selection after a staged file leaves its entry: the reset link still resets it', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.setInputFiles('#docA', []);
        await pw.waitForTimeout(400);
        const afterEmpty = await state(pw);
        expect(afterEmpty.resetLinkPresent, 'the staged file\'s reset link stays').toBe(true);
        expect(afterEmpty.customFiles, 'the staged entry stays on the input').toEqual([{ name: 'me.png', deleteLinkId: null }]);
        await pw.click('#docA-0-reset-trigger');
        await settle(pw, log);
        const after = await state(pw);
        record('F5', log, { afterEmpty: afterEmpty, after: after });
        expect(log.remove, 'the reset request went out').toEqual(['POST {"files":["me.png"]}']);
        expect(after.resetLinkPresent, 'the link went with the file').toBe(false);
        expect(log.stage.length, 'the empty selection staged nothing').toBe(1);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('O4 OBSERVE — an empty selection (the picker cancelled) after a stored file, then its delete link clicked', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_ONE), 'image');
        await ready(pw);
        await pw.setInputFiles('#docA', []);
        await pw.waitForTimeout(400);
        const s = await state(pw);
        let clicked = false;
        if (s.deleteLinks.length) { await pw.click('#docA-0-delete-trigger'); clicked = true; }
        await settle(pw, log);
        record('O4', log, { afterCancel: s, clicked: clicked });
        expect(log.errors).toEqual([]);
    });

    test('O1C CONTROL — the same edit form, no new file chosen: the stored file\'s delete link removes it', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="old.png"><input type="hidden" name="doc[0][location]" value="/media/stored/old.png">'
            + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
            + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        await pw.click('#docA-0-delete-trigger');
        await settle(pw, log);
        record('O1C', log);
        expect(log.remove).toEqual(['DELETE ']);
        expect(log.b150).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('O2 OBSERVE — the report\'s context: a form injected after load, bound with getFormById, then a staged image reset', async ({ page: pw }) => {
        const INJECT = FORM_OPEN + '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>' + FORM_CLOSE;
        const log = await open(pw, HEAD + '<div id="host"></div>' + DECLARED + '</body></html>', 'image');
        await ready(pw, ['b459declared']);
        const bound = await pw.evaluate((html) => {
            document.getElementById('host').innerHTML = html;
            try { window.gina.validator.getFormById('b459form'); return 'BOUND'; } catch (e) { return 'THREW ' + e.message; }
        }, INJECT);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        const resetLinkPresent = await pw.evaluate(() => !!document.getElementById('docA-0-reset-trigger'));
        if (resetLinkPresent) { await pw.click('#docA-0-reset-trigger'); }
        await settle(pw, log);
        record('O2', log, { bound: bound, resetLinkPresent: resetLinkPresent });
        expect(log.errors).toEqual([]);
    });
});
