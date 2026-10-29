'use strict';

/**
 * #B990 — a re-bind of a form (`$forms[id].reBind()`, `.bind()`, a bind after `destroy()`) while a file
 * input showed files it had staged read their previews as saved files. An image staged warned « did not
 * find `upload delete trigger` » for a link the page never had; a file shown without an image (a PDF with
 * no thumbnail) lost its entry, so its reset did nothing and the save posted the file the user had removed;
 * beside an image on a `multiple` input, its reset removed the image instead. A re-bind now leaves the
 * input's entries as they are while its staged files have their reset controls on the page.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). Each page rides /x76-page?b64=
 * with the b459 rules whisper; each staging answer is route-fulfilled, naming the files the request carried,
 * and the removal and save requests are route-fulfilled and recorded with their bodies. A console.warn
 * wrapper installed before the page's scripts records each warning carrying the needle.
 *
 *   01 a PDF staged, then reBind(): its reset removes it and the save posts no file, no warning
 *   02 an image and a PDF staged on a `multiple` input, then reBind(): the PDF's reset removes the PDF and
 *      the save does not post it
 *   03 an image staged, then reBind(): no warning, and its reset removes it
 *   04 a PDF staged, then `$forms[id].bind()`: its reset removes it and the save posts no file
 *   05 a PDF staged, then `destroy()` and `validateFormById()`: the same
 *   06 CONTROL a PDF staged, no re-bind: its reset removes it and the save posts no file
 *   07 CONTROL after a save, the page shows the saved file in the container with its delete link and
 *      re-binds: the delete sends one DELETE and removes the file's node (a container the page replaced is
 *      read again)
 *
 * RED-FIRST, measured 2026-10-29 on develop `c91fbf88f`'s committed dist, and through
 * GINA_B990_PREFIX_BUNDLE=<path to that gina.min.js> (page.route, nothing written to disk; `routeHits`
 * proves the old bytes ran): arms 01 to 05 fail on their removal or warning assertion, the two CONTROL arms
 * pass. Green after the rebuild.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-rebind-b990.spec.js
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

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload re-bind</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

/** The upload warning's fixed head. */
const NEEDLE = 'did not find `upload';

/** A file input with its default preview container `docA-preview`. */
function uploadInput(multiple) {
    return '<input id="docA" type="file" name="doc"' + (multiple ? ' multiple' : '') + ' ' + ACTIONS + '>'
        + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';
}

/** The staging answer for `name`: an image, or a PDF with no `preview` thumbnail. */
function staged(name) {
    const entry = { name: 'staged-' + name, group: 'untagged', originalFilename: name, encoding: '7bit', size: 69,
        location: '/tmp/uploads/staged-' + name, tmpUri: '/upload-tmp/staged-' + name };
    if (/\.pdf$/.test(name)) {
        return Object.assign(entry, { ext: 'pdf', mime: 'application/pdf' });
    }
    return Object.assign(entry, { ext: 'png', mime: 'image/png', width: 1, height: 1 });
}

/** A page holding `inner` in form b459form. */
function page(inner) {
    return HEAD
        + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">' + inner
        + '<button id="b459form-submit" type="submit">Save</button></form>'
        + '</body></html>';
}

/**
 * Routes the bundle (red-first seam), the staging, removal and save answers, installs the warning probe
 * and records the requests and page errors, then loads `html`.
 */
async function open(pw, html) {
    const log = { stage: 0, remove: [], save: [], errors: [], routeHits: 0 };
    if (process.env.GINA_B990_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.GINA_B990_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await pw.route('**/upload-stage', async (route) => {
        const s = (requestBody(route.request()) || Buffer.alloc(0)).toString('latin1');
        const names = [];
        const re = /filename="([^"]+)"/g;
        let m;
        while ((m = re.exec(s))) { names.push(m[1]); }
        await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: names.map(staged) }) });
    });
    await pw.route('**/upload-unstage**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await pw.route('**/upload-save**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage++; }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
        if (u.indexOf('/upload-save') > -1) { log.save.push(r.postData() || ''); }
    });
    await pw.addInitScript((needle) => {
        window.__warnings = [];
        var warn = console.warn;
        console.warn = function () {
            try {
                var t = String(arguments[0]);
                if (t.indexOf(needle) > -1) {
                    var m = t.match(/element ID is `([^`]+)`/);
                    window.__warnings.push(m ? m[1] : t.slice(0, 120));
                }
            } catch (e) { /* the probe never breaks the page */ }
            return warn.apply(console, arguments);
        };
    }, NEEDLE);
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    if (process.env.GINA_B990_PREFIX_BUNDLE) { expect(log.routeHits, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return log;
}

/** Resolves once the field `name` of b459form holds `value`; false after the timeout. */
function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

/** Selects `files` on docA and waits for the staging answer to fill the fields of the last one. */
async function select(pw, log, files) {
    const before = log.stage;
    await pw.setInputFiles('#docA', files.map((name) => ({ name: name, mimeType: /\.pdf$/.test(name) ? 'application/pdf' : 'image/png', buffer: PNG })));
    await expect.poll(() => log.stage, { timeout: 6000 }).toBeGreaterThan(before);
    const last = files.length - 1;
    expect(await filled(pw, 'doc[' + last + '][location]', '/tmp/uploads/staged-' + files[last])).toBe(true);
    await pw.waitForTimeout(400);
}

/** The hidden fields of docA's files, as `name=value`. */
function uploadFields(pw) {
    return pw.evaluate(() => Array.from(document.querySelectorAll('#b459form input[type="hidden"]'))
        .filter((h) => /^doc\[/.test(h.name)).map((h) => h.name + '=' + h.value));
}

/** The warnings the probe recorded. */
function warnings(pw) {
    return pw.evaluate(() => window.__warnings.slice());
}

/** Clicks the reset control `id` and waits for the removal request it sends; false after the timeout. */
async function reset(pw, log, id) {
    const before = log.remove.length;
    await pw.click('#' + id);
    return expect.poll(() => log.remove.length, { timeout: 3000 }).toBeGreaterThan(before).then(() => true, () => false);
}

/** Submits b459form and returns the save request's body. */
async function save(pw, log) {
    const before = log.save.length;
    await pw.click('#b459form-submit');
    await expect.poll(() => log.save.length, { timeout: 8000 }).toBeGreaterThan(before);
    return log.save[log.save.length - 1];
}

const REBINDS = {
    reBind: () => window.gina.validator.$forms['b459form'].reBind(),
    bind: () => window.gina.validator.$forms['b459form'].bind(),
    destroy: () => { window.gina.validator.$forms['b459form'].destroy(); window.gina.validator.validateFormById('b459form'); }
};

test.describe('#B990 a re-bind keeps the files an upload input staged', () => {

    for (const [num, how, label] of [['01', 'reBind', 'reBind()'], ['04', 'bind', '$forms[id].bind()'], ['05', 'destroy', 'destroy() and validateFormById()']]) {
        test(num + ' a PDF staged, then ' + label + ': its reset removes it and the save posts no file', async ({ page: pw }) => {
            const log = await open(pw, page(uploadInput(false)));
            await select(pw, log, ['me.pdf']);
            await pw.evaluate(REBINDS[how]);
            await pw.waitForTimeout(400);
            expect(await warnings(pw)).toEqual([]);
            expect(await reset(pw, log, 'docA-0-reset-trigger'), 'the reset sent a removal request').toBe(true);
            expect(log.remove).toEqual(['POST {"files":["me.pdf"]}']);
            expect(await uploadFields(pw)).toEqual([]);
            expect(await save(pw, log)).not.toContain('me.pdf');
            expect(log.errors).toEqual([]);
        });
    }

    test('02 an image and a PDF staged on a multiple input, then reBind(): the PDF\'s reset removes the PDF', async ({ page: pw }) => {
        const log = await open(pw, page(uploadInput(true)));
        await select(pw, log, ['me.png', 'doc.pdf']);
        await pw.evaluate(REBINDS.reBind);
        await pw.waitForTimeout(400);
        const atRebind = await warnings(pw);
        expect(await reset(pw, log, 'docA-1-reset-trigger'), 'the reset sent a removal request').toBe(true);
        expect(log.remove.length).toBe(1);
        expect(JSON.parse(log.remove[0].replace(/^POST /, '')).files, 'the removal names the PDF').toContain('doc.pdf');
        expect((await uploadFields(pw)).filter((f) => f.indexOf('doc.pdf') > -1)).toEqual([]);
        expect(await save(pw, log)).not.toContain('doc.pdf');
        expect(atRebind, 'the re-bind read the staged image as a saved file').toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('03 an image staged, then reBind(): no warning, and its reset removes it', async ({ page: pw }) => {
        const log = await open(pw, page(uploadInput(false)));
        await select(pw, log, ['me.png']);
        await pw.evaluate(REBINDS.reBind);
        await pw.waitForTimeout(400);
        expect(await warnings(pw), 'the re-bind read the staged preview as a saved file').toEqual([]);
        expect(await reset(pw, log, 'docA-0-reset-trigger'), 'the reset sent a removal request').toBe(true);
        expect(log.remove).toEqual(['POST {"files":["me.png"]}']);
        expect(await uploadFields(pw)).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    test('06 CONTROL a PDF staged, no re-bind: its reset removes it and the save posts no file', async ({ page: pw }) => {
        const log = await open(pw, page(uploadInput(false)));
        await select(pw, log, ['me.pdf']);
        expect(await reset(pw, log, 'docA-0-reset-trigger'), 'the reset sent a removal request').toBe(true);
        expect(log.remove).toEqual(['POST {"files":["me.pdf"]}']);
        expect(await uploadFields(pw)).toEqual([]);
        expect(await save(pw, log)).not.toContain('me.pdf');
        expect(log.errors).toEqual([]);
    });

    test('07 CONTROL after a save, the page shows the saved file with its delete link and re-binds: the delete works', async ({ page: pw }) => {
        const log = await open(pw, page(uploadInput(false)));
        await select(pw, log, ['me.pdf']);
        await save(pw, log);
        await pw.evaluate(() => {
            document.getElementById('docA-preview').innerHTML = '<a href="/media/stored/me.pdf" data-upload-original-filename="me.pdf">me.pdf</a>'
                + '<a href="#" id="docA-0-delete-trigger">Delete</a>';
        });
        await pw.evaluate(REBINDS.reBind);
        await pw.waitForTimeout(400);
        expect(await warnings(pw)).toEqual([]);
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length, { timeout: 3000 }).toBe(1);
        expect(log.remove[0]).toMatch(/^DELETE /);
        expect(await pw.locator('#docA-preview [data-upload-original-filename]').count()).toBe(0);
        expect(log.errors).toEqual([]);
    });
});
