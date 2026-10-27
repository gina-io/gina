'use strict';

/**
 * #B858 - #B862 (gh#85) — the staged-upload layer after a reset or a delete: what the form
 * holds, what the server is told to remove, and what the save posts.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). Each page rides
 * /x76-page?b64= with the b459 rules whisper; each staging answer is route-fulfilled, naming the
 * file the request carried, as an image, a file with a preview, or a file without one.
 *
 *   01 #B858 a reset, then another file: its fields, the declared `[preview][*]` ones included,
 *            are in the form and posted
 *   02 #B858 the same with an image, in a form that declares no preview field
 *   03 CONTROL another file chosen without a reset: its fields are posted
 *   04 #B859 a staged file shown without an image is reset: fields gone, the server told
 *   05 CONTROL a staged image is reset
 *   06 #B859 a staged image in a `<ul>` container (gina wraps it in an <li>) is reset
 *   07 #B860 a reset on a multi-file input removes every file, in one request, without throwing
 *   08 CONTROL a stored image of an edit form is deleted
 *   09 #B860 a delete on the second of two stored files: one request, no stale file posted
 *   10 #B859 a stored file shown without an image, its node marked `data-upload-original-filename`,
 *            is deleted
 *   11 #B858 an edit form: the stored file deleted, then a new file without a preview: the
 *            declared preview inputs come back, empty
 *   12 #B861 a custom preview container id: the reset link is created and works
 *   13 #B861 no preview container: the staging answer still fills the fields
 *   14 #B862 a custom field prefix: the reset removes those fields
 *   15 CONTROL a smaller re-selection on a multiple input: index 0 describes the new file
 *   16 #B858 the same as 01 inside a popin
 *   17 a page that removes the virtual upload form after a reset (the workaround published with
 *      the issue) keeps working, its preview fields included
 *   18 #B858 a larger re-selection without a reset: the new files get their fields and are posted
 *
 * Not asserted, deliberately: what a smaller re-selection leaves at the indices it no longer
 * fills (#B864), the `name` field of a re-selection made without a reset (#B863), and that any one
 * reset or delete control removes every file of its input (#B865) — each filed on its own.
 *
 * RED-FIRST, measured 2026-10-14 on the committed dist of develop `bdb2c052a` served through
 * B858_PREFIX_BUNDLE=<path to that gina.min.js> (page.route, nothing written to disk; `routeHits`
 * proves the old bytes ran): the four CONTROL arms (03, 05, 08, 15) pass and every other arm fails
 * on its own assertion. Green after the rebuild.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-reset-reselect-b858.spec.js
 */

const { test, expect } = require('@playwright/test');
// WebKit hands Playwright no body for gina's Blob staging request, so a mock reading the staged
// file names from it would answer "no files" there: copy each Blob body into a header that
// requestBody() falls back to (helpers/request-body.js, #B996).
const { copyBlobBodies, requestBody } = require('./helpers/request-body');
test.beforeEach(async ({ context }) => { await context.addInitScript(copyBlobBodies); });
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload reset</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

/** A file of the selection: a PDF or a PNG, by its extension. */
function file(name) {
    return /pdf$/.test(name)
        ? { name: name, mimeType: 'application/pdf', buffer: PDF }
        : { name: name, mimeType: 'image/png', buffer: PNG };
}

/** The base name of a file name, without its extension. */
function base(name) { return name.replace(/\.[^.]+$/, ''); }

/** The preview the staging answer nests for `name`. */
function preview(name) {
    return {
        originalFilename: 'staged-' + base(name) + '-preview.png',
        location: '/tmp/uploads/staged-' + base(name) + '-preview.png',
        uri: '/media/previews/staged-' + base(name) + '-preview.png',
        tmpUri: '/upload-tmp/staged-' + base(name) + '-preview.png',
        width: 1, height: 1
    };
}

/** Staging answers, by shape: each names the file the request carried. */
const ANSWERS = {
    image: (name) => ({ name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-' + name, mime: 'image/png', tmpUri: '/upload-tmp/staged-' + name }),
    pdf: (name) => ({ name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'pdf', encoding: '7bit',
        size: 44, location: '/tmp/uploads/staged-' + name, mime: 'application/pdf', tmpUri: '/upload-tmp/staged-' + name }),
    pdfWithPreview: (name) => Object.assign(ANSWERS.pdf(name), { preview: preview(name) })
};

/** A page holding `inner` in form b459form, plus the b459declared form the whisper names. */
function page(inner) {
    return HEAD
        + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">' + inner
        + '<button id="b459form-submit" type="submit">Save</button></form>'
        + '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
        + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>'
        + '</body></html>';
}

/** The four declared preview inputs of file 0. */
function declaredPreview(values) {
    const v = values || {};
    return ['location', 'uri', 'width', 'height'].map((k) =>
        '<input type="hidden" name="doc[0][preview][' + k + ']"' + (v[k] ? ' value="' + v[k] + '"' : '') + '>').join('');
}

/**
 * Routes the bundle (red-first seam), the staging answers and any extra route, records the
 * requests and the page errors, then loads `html`.
 */
async function open(pw, html, answer, extraRoutes) {
    const log = { stage: [], remove: [], saves: [], errors: [], routeHits: 0 };
    if (process.env.B858_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B858_PREFIX_BUNDLE);
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
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage.push(r.method()); }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
        if (u.indexOf('/upload-save') > -1) { log.saves.push(r.postData() || ''); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    return log;
}

/** Waits until the validator has bound both forms. */
function ready(pw) {
    return pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']
        && window.gina.validator.$forms['b459declared']), null, { timeout: 15000 });
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

/** Resolves once the field `name` of b459form holds `value`; false after the timeout. */
function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

/** Selects `names` in the file input, then waits for the staging request and its fill. */
async function select(pw, log, names, input, prefix) {
    const before = log.stage.length;
    const files = names.map(file);
    await pw.setInputFiles('#' + (input || 'docA'), files.length > 1 ? files : files[0]);
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    return filled(pw, (prefix || 'doc') + '[0][location]', '/tmp/uploads/staged-' + names[0]);
}

/** Submits b459form and returns the save body, parsed. */
async function save(pw, log) {
    await pw.click('#b459form-submit', { force: true });
    await expect.poll(() => log.saves.length, { timeout: 8000 }).toBe(1);
    return JSON.parse(log.saves[0]);
}

/** The names of the controls whose name starts with `prefix[i]`. */
function at(fieldMap, prefix) {
    return Object.keys(fieldMap).filter((n) => n.indexOf(prefix) === 0);
}

/** The checks every arm makes: the seam served, no uncaught error. */
function common(log) {
    if (process.env.B858_PREFIX_BUNDLE) { expect(log.routeHits, 'the pre-fix bundle was not served').toBeGreaterThan(0); }
    expect(log.errors, 'uncaught exception on the page').toEqual([]);
}

test.describe('#B858 - #B862 staged-upload reset and delete', () => {

    test('01 #B858 a reset, then another file: its fields and the declared preview are posted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + declaredPreview() + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'pdfWithPreview');
        await ready(pw);
        expect(await select(pw, log, ['report.pdf']), 'the first file filled the form').toBe(true);
        expect(at(await fields(pw), 'doc[0]').length).toBe(12);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["report.pdf","staged-report-preview.png"]}');
        expect(at(await fields(pw), 'doc[0]')).toEqual([]);
        expect(await select(pw, log, ['photo.pdf']), 'the second file filled the form').toBe(true);
        const f = await fields(pw);
        expect(f['doc[0][preview][uri]']).toBe('/media/previews/staged-photo-preview.png');
        expect(at(f, 'doc[0]').length).toBe(12);
        const body = await save(pw, log);
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-photo.pdf');
        expect(body.doc[0].preview.location).toBe('/tmp/uploads/staged-photo-preview.png');
        common(log);
    });

    test('02 #B858 a reset, then another image, in a form that declares no preview field', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(at(await fields(pw), 'doc[0]')).toEqual([]);
        expect(await select(pw, log, ['you.png']), 'the second image filled the form').toBe(true);
        expect(at(await fields(pw), 'doc[0]').length).toBe(10);
        const body = await save(pw, log);
        expect(body.doc[0].originalFilename).toBe('you.png');
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-you.png');
        common(log);
    });

    test('03 CONTROL another file chosen without a reset: its fields are posted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        expect(await select(pw, log, ['you.png'])).toBe(true);
        const body = await save(pw, log);
        expect(body.doc[0].originalFilename).toBe('you.png');
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-you.png');
        expect(log.remove).toEqual([]);
        common(log);
    });

    test('04 #B859 a staged file shown without an image is reset', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'pdf');
        await ready(pw);
        expect(await select(pw, log, ['contract.pdf'])).toBe(true);
        expect(at(await fields(pw), 'doc[0]').length).toBe(8);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length, { message: 'the server was told to remove the file' }).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["contract.pdf"]}');
        expect(at(await fields(pw), 'doc[0]')).toEqual([]);
        expect(await pw.locator('#docA-0-reset-trigger').count()).toBe(0);
        const body = await save(pw, log);
        expect(body.doc, 'the reset file is not posted').toBeUndefined();
        common(log);
    });

    test('05 CONTROL a staged image is reset', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png"]}');
        expect(at(await fields(pw), 'doc[0]')).toEqual([]);
        expect(await pw.locator('#docA-preview *').count()).toBe(0);
        common(log);
    });

    test('06 #B859 a staged image in a <ul> container is reset', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<ul id="docA-preview"></ul><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        expect(await pw.locator('#docA-preview > li > img').count()).toBe(1);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length, { message: 'the server was told to remove the file' }).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png"]}');
        expect(at(await fields(pw), 'doc[0]')).toEqual([]);
        expect(await pw.locator('#docA-preview *').count(), 'the image, the link and their <li> are gone').toBe(0);
        common(log);
    });

    test('07 #B860 a reset on a multi-file input removes every file, in one request', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png', 'you.png'])).toBe(true);
        expect(await filled(pw, 'doc[1][location]', '/tmp/uploads/staged-you.png')).toBe(true);
        expect(Object.keys(await fields(pw)).length).toBe(20);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length, { message: 'the server was told to remove the files' }).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png","you.png"]}');
        expect(await fields(pw)).toEqual({});
        expect(await pw.evaluate(() => document.getElementById('docA').value)).toBe('');
        const body = await save(pw, log);
        expect(body.doc).toBeUndefined();
        common(log);
    });

    test('08 CONTROL a stored image of an edit form is deleted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="photo.png"><input type="hidden" name="doc[0][location]" value="/media/stored/photo.png">'
            + '<div id="docA-preview"><img src="/upload-tmp/photo.png" alt=""><a href="#" id="docA-0-delete-trigger">Delete</a></div>'
            + '<p id="docA-error" hidden></p>'), null);
        await ready(pw);
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('DELETE ');
        expect(await fields(pw)).toEqual({});
        expect(await pw.locator('#docA-preview *').count()).toBe(0);
        const body = await save(pw, log);
        expect(body.doc).toBeUndefined();
        common(log);
    });

    test('09 #B860 a delete on the second of two stored files: one request, no stale file posted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="one.png"><input type="hidden" name="doc[0][location]" value="/media/stored/one.png">'
            + '<input type="hidden" name="doc[1][name]" value="two.png"><input type="hidden" name="doc[1][location]" value="/media/stored/two.png">'
            + '<div id="docA-preview"><img src="/upload-tmp/one.png" alt=""><img src="/upload-tmp/two.png" alt=""></div>'
            + '<div><a href="#" id="docA-0-delete-trigger">Delete 1</a> <a href="#" id="docA-1-delete-trigger">Delete 2</a></div>'
            + '<p id="docA-error" hidden></p>'), null);
        await ready(pw);
        await pw.click('#docA-1-delete-trigger');
        await expect.poll(() => log.remove.length).toBeGreaterThan(0);
        await pw.waitForTimeout(300);
        expect(log.remove, 'one request naming both files').toEqual(['POST {"files":["one.png","two.png"]}']);
        expect(await fields(pw)).toEqual({});
        const body = await save(pw, log);
        expect(body.doc, 'no deleted file is posted').toBeUndefined();
        common(log);
    });

    test('10 #B859 a stored file shown without an image, its node marked, is deleted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<input type="hidden" name="doc[0][name]" value="contract.pdf"><input type="hidden" name="doc[0][location]" value="/media/stored/contract.pdf">'
            + '<div id="docA-preview"><a class="file" data-upload-original-filename="contract.pdf" href="/media/stored/contract.pdf">contract.pdf</a></div>'
            + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>'), null);
        await ready(pw);
        expect(await pw.evaluate(() => document.getElementById('docA-0-delete-trigger').isBinded === true), 'the delete link is bound').toBe(true);
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('DELETE ');
        expect(await fields(pw)).toEqual({});
        expect(await pw.locator('#docA-preview *').count()).toBe(0);
        const body = await save(pw, log);
        expect(body.doc).toBeUndefined();
        common(log);
    });

    test('11 #B858 an edit form: delete, then a new file without a preview: the declared preview inputs come back empty', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + declaredPreview({ location: '/stored/old-preview.png', uri: '/media/old-preview.png', width: '320', height: '240' })
            + '<div id="docA-preview"><img src="/upload-tmp/old.png" alt=""></div>'
            + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>'), 'pdf');
        await ready(pw);
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(await fields(pw)).toEqual({});
        expect(await select(pw, log, ['new.pdf'])).toBe(true);
        const f = await fields(pw);
        expect(f['doc[0][preview][location]'], 'the declared preview input is back, empty').toBe('');
        expect(f['doc[0][preview][uri]']).toBe('');
        const body = await save(pw, log);
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-new.pdf');
        expect(body.doc[0].preview).toEqual({ location: '', uri: '', width: '', height: '' });
        common(log);
    });

    test('12 #B861 a custom preview container id: the reset link is created and works', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" data-gina-form-upload-preview="thumbsA" ' + ACTIONS + '>'
            + '<div id="thumbsA"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'])).toBe(true);
        expect(await pw.evaluate(() => document.getElementById('thumbsA').className), 'the container is not taken for the link').toBe('');
        expect(await pw.locator('#thumbsA #docA-0-reset-trigger').count()).toBe(1);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png"]}');
        expect(await fields(pw)).toEqual({});
        expect(await pw.locator('#thumbsA *').count()).toBe(0);
        common(log);
    });

    test('13 #B861 no preview container: the staging answer fills the fields', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png']), 'the staging answer filled the form').toBe(true);
        const body = await save(pw, log);
        expect(body.doc[0].originalFilename).toBe('me.png');
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-me.png');
        common(log);
    });

    test('14 #B862 a custom field prefix: the reset removes those fields', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" data-gina-form-upload-prefix="attachment" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png'], 'docA', 'attachment')).toBe(true);
        expect(at(await fields(pw), 'attachment[0]').length).toBe(10);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png"]}');
        expect(await fields(pw), 'no field of the removed file is left').toEqual({});
        const body = await save(pw, log);
        expect(body.attachment, 'the file the server was told to remove is not posted').toBeUndefined();
        common(log);
    });

    test('15 CONTROL a smaller re-selection on a multiple input: index 0 describes the new file', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['me.png', 'you.png'])).toBe(true);
        expect(await select(pw, log, ['solo.png'])).toBe(true);
        const body = await save(pw, log);
        expect(body.doc[0].originalFilename).toBe('solo.png');
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-solo.png');
        common(log);
    });

    test('16 #B858 inside a popin: a reset, then another file: its fields and the declared preview are posted', async ({ page: pw }) => {
        const PAGE = HEAD + '<h1>p</h1><button data-gina-popin-name="upl" data-gina-popin-url="/frag/upl.html" data-gina-dialog-preload="false">Open</button></body></html>';
        const FRAG = '<div id="upl-frag"><form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
            + '<input id="titleA" type="text" name="title" value="t">'
            + '<input id="docA" type="file" name="doc" ' + ACTIONS + ' data-gina-form-upload-preview="docA-preview">'
            + declaredPreview() + '<div id="docA-preview"></div><progress id="docA-progress"></progress><p id="docA-error" hidden></p>'
            + '<button id="b459form-submit" type="submit">Save</button></form><button class="gina-popin-close" type="button">Close</button></div>';
        const log = await open(pw, PAGE, 'pdfWithPreview', [['**/frag/upl.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAG })]]);
        await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && window.gina.validator), null, { timeout: 15000 });
        const reg = await pw.evaluate(() => new Promise((resolve) => {
            setTimeout(() => resolve('TIMEOUT'), 8000);
            window.require(['gina/popin'], function (Popin) { new Popin({ name: 'upl', validator: window.gina.validator }).on('ready', function () { resolve('READY'); }); });
        }));
        expect(reg).toBe('READY');
        await pw.click('[data-gina-popin-name="upl"]');
        await pw.waitForFunction(() => { const p = window.gina.popin.getPopinByName('upl'); const f = document.getElementById('b459form'); return !!(p && p.isOpen && f && f.closest('dialog')); }, null, { timeout: 8000 });
        await pw.evaluate(() => {
            window.__states = [];
            const el = document.getElementById('docA-progress');
            new MutationObserver(() => { window.__states.push(el.getAttribute('data-gina-upload-progress-state')); })
                .observe(el, { attributes: true, attributeFilter: ['data-gina-upload-progress-state'] });
        });
        expect(await select(pw, log, ['a.pdf'])).toBe(true);
        await pw.click('#docA-0-reset-trigger', { force: true });
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["a.pdf","staged-a-preview.png"]}');
        expect(await fields(pw)).toEqual({});
        await pw.evaluate(() => { window.__states.splice(0); });
        expect(await select(pw, log, ['b.pdf']), 'the second file filled the form').toBe(true);
        const f = await fields(pw);
        expect(f['doc[0][preview][uri]']).toBe('/media/previews/staged-b-preview.png');
        expect(await pw.evaluate(() => window.__states.slice()), 'the second selection reached the upload properties').toContain('preparing');
        const body = await save(pw, log);
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-b.pdf');
        expect(body.doc[0].preview.location).toBe('/tmp/uploads/staged-b-preview.png');
        common(log);
    });

    test('17 a page that removes the virtual upload form after a reset keeps working, its preview fields included', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + declaredPreview() + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'
            + '<script>document.addEventListener("click", function (e) { var t = e.target.closest && e.target.closest("a[id$=\\"-reset-trigger\\"]");'
            + ' if (!t) return; setTimeout(function () { var i = document.getElementById("docA"); var id = i.getAttribute("data-gina-form-virtual");'
            + ' var f = id && document.getElementById(id); if (f) { f.remove(); window.__released = (window.__released || 0) + 1; } }, 0); }, true);</script>'),
        'pdfWithPreview');
        await ready(pw);
        expect(await select(pw, log, ['a.pdf'])).toBe(true);
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        await expect.poll(() => pw.evaluate(() => window.__released || 0), { message: 'the page removed the virtual form' }).toBe(1);
        expect(await select(pw, log, ['b.pdf'])).toBe(true);
        const f = await fields(pw);
        expect(f['doc[0][preview][uri]'], 'the declared preview input is back and filled').toBe('/media/previews/staged-b-preview.png');
        const counts = await pw.evaluate(() => {
            const out = {};
            document.getElementById('b459form').querySelectorAll('input').forEach((el) => { if (/^doc\[0\]/.test(el.name)) { out[el.name] = (out[el.name] || 0) + 1; } });
            return out;
        });
        expect(Object.values(counts).every((n) => n === 1), 'no field is doubled').toBe(true);
        const body = await save(pw, log);
        expect(body.doc[0].location).toBe('/tmp/uploads/staged-b.pdf');
        expect(body.doc[0].preview.location).toBe('/tmp/uploads/staged-b-preview.png');
        common(log);
    });

    test('18 #B858 a larger re-selection without a reset: the new files get their fields and are posted', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" multiple ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'), 'image');
        await ready(pw);
        expect(await select(pw, log, ['one.png'])).toBe(true);
        expect(await select(pw, log, ['two.png', 'three.png'])).toBe(true);
        expect(await filled(pw, 'doc[1][location]', '/tmp/uploads/staged-three.png'), 'the second file filled its own fields').toBe(true);
        const body = await save(pw, log);
        expect(body.doc.length).toBe(2);
        expect(body.doc[1].originalFilename).toBe('three.png');
        expect(body.doc[1].location).toBe('/tmp/uploads/staged-three.png');
        common(log);
    });
});
