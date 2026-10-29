'use strict';

/**
 * #B1027 — a reset named a file or its preview « undefined » when the staging answer gave no name. The
 * staging success wrote the answer's `originalFilename` (the file's, and its `preview`'s) onto the preview
 * node without a check, and `setAttribute(name, undefined)` stores the text « undefined »: the reset then
 * sent that text in its `{ "files": [ … ] }` body and passed it to the removal callback. A preview the answer
 * leaves unnamed (the guide's own example shape) is now left out of the reset, and a file the answer leaves
 * unnamed is named by the browser file's name.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). Each page rides /x76-page?b64=
 * with the b459 rules whisper; each staging answer is route-fulfilled from the selected file's name, and the
 * removal request is route-fulfilled and recorded with its body. The file input carries
 * `data-gina-form-upload-on-reset`; an init script records the `files` each callback receives. Each arm
 * checks one observation: the removal request, the callback's files, the preview nodes whose name
 * attribute holds « undefined » (read before the reset), and the images left after it.
 *
 *   01 a PDF whose answer's `preview` carries no `originalFilename`: the reset names the file only
 *   02 an image whose answer's `preview` carries no `originalFilename`: the reset names the file only
 *   03 a PDF whose answer gives no `originalFilename`, its preview named: the reset names the browser
 *      file, then the preview
 *   04 an image whose answer gives no `originalFilename` and no preview: the reset names the browser file
 *   05 CONTROL a PDF whose preview is named: the reset names the file and its preview
 *   06 CONTROL an image with no preview: the reset names the file
 *
 * RED-FIRST, measured 2026-10-29 through GINA_B1027_PREFIX_BUNDLE=<path to a gina.min.js> (page.route,
 * nothing written to disk; `routeHits` proves the old bytes ran), with the committed dist of develop
 * `c91fbf88f` and of the parent commit `044381017`: arms 01 to 04 fail on their observation (the removal
 * body and the callback's files carry « undefined », and a preview node holds it), the two CONTROL arms
 * pass, on Chromium and WebKit. Green after the rebuild, on both engines.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-unnamed-b1027.spec.js
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

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload unnamed</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

/** A file input with its default preview container `docA-preview` and a removal callback. */
const INPUT = '<input id="docA" type="file" name="doc" ' + ACTIONS + ' data-gina-form-upload-on-reset="onB1027Reset">'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';

/**
 * The staging answer for the selected file `name`, keyed by its name:
 *   me-thumb.pdf    a PDF whose `preview` carries no `originalFilename` (the guide's example shape)
 *   img-thumb.png   an image whose `preview` carries no `originalFilename`
 *   anon-named.pdf  a PDF with no `originalFilename` of its own, its `preview` named
 *   anon.png        an image with no `originalFilename` and no `preview`
 *   me-named.pdf    a PDF whose `preview` names itself
 *   me.png          an image with no `preview`
 */
function staged(name) {
    const pdf = /\.pdf$/.test(name);
    const entry = { name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: pdf ? 'pdf' : 'png',
        encoding: '7bit', size: 69, location: '/tmp/uploads/staged-' + name, mime: pdf ? 'application/pdf' : 'image/png',
        tmpUri: '/upload-tmp/staged-' + name };
    if (!pdf) { entry.width = 1; entry.height = 1; }
    if (/^anon/.test(name)) { delete entry.originalFilename; }
    if (/-(thumb|named)\./.test(name)) {
        entry.preview = { location: '/tmp/uploads/staged-' + name + '-preview.png', uri: '/media/previews/' + name + '-preview.png',
            tmpUri: '/upload-tmp/staged-' + name + '-preview.png', width: 1, height: 1 };
        if (/-named\./.test(name)) { entry.preview.originalFilename = 'staged-' + name + '-preview.png'; }
    }
    return entry;
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
 * Routes the bundle (red-first seam), the staging and removal answers, installs the removal callback and
 * records the requests and page errors, then loads `html`.
 */
async function open(pw, html) {
    const log = { stage: 0, remove: [], errors: [], routeHits: 0 };
    if (process.env.GINA_B1027_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.GINA_B1027_PREFIX_BUNDLE);
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
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage++; }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
    });
    await pw.addInitScript(() => {
        window.__resets = [];
        window.onB1027Reset = function (payload) {
            var files = payload && payload.files;
            window.__resets.push(Array.isArray(files) ? files.slice() : String(files));
        };
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    if (process.env.GINA_B1027_PREFIX_BUNDLE) { expect(log.routeHits, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    return log;
}

/** Resolves once the field `name` of b459form holds `value`; false after the timeout. */
function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

/** Selects the file `name` on docA and waits for the staging answer to fill its fields. */
async function select(pw, log, name) {
    const before = log.stage;
    await pw.setInputFiles('#docA', { name: name, mimeType: /\.pdf$/.test(name) ? 'application/pdf' : 'image/png', buffer: PNG });
    await expect.poll(() => log.stage, { timeout: 6000 }).toBeGreaterThan(before);
    expect(await filled(pw, 'doc[0][location]', '/tmp/uploads/staged-' + name)).toBe(true);
    await pw.waitForTimeout(400);
}

/** The tag names of docA's preview nodes whose file or preview name attribute holds the text « undefined ». */
function namedUndefined(pw) {
    return pw.evaluate(() => Array.from(document.querySelectorAll('#docA-preview [data-upload-original-filename], #docA-preview [data-upload-preview-original-filename]'))
        .filter((n) => n.getAttribute('data-upload-original-filename') === 'undefined'
            || n.getAttribute('data-upload-preview-original-filename') === 'undefined')
        .map((n) => n.tagName));
}

/** Clicks docA's reset control and waits for its removal request and its callback. */
async function reset(pw, log) {
    const before = log.remove.length;
    await pw.click('#docA-0-reset-trigger');
    await expect.poll(() => log.remove.length, { timeout: 3000 }).toBeGreaterThan(before);
    await expect.poll(() => pw.evaluate(() => window.__resets.length), { timeout: 3000 }).toBeGreaterThan(0);
    await pw.waitForTimeout(300);
}

const ARMS = [
    ['01', 'me-thumb.pdf', 'a PDF whose answer\'s preview carries no originalFilename: the reset names the file only',
        ['me-thumb.pdf']],
    ['02', 'img-thumb.png', 'an image whose answer\'s preview carries no originalFilename: the reset names the file only',
        ['img-thumb.png']],
    ['03', 'anon-named.pdf', 'a PDF whose answer gives no originalFilename, its preview named: the reset names the browser file, then the preview',
        ['anon-named.pdf', 'staged-anon-named.pdf-preview.png']],
    ['04', 'anon.png', 'an image whose answer gives no originalFilename and no preview: the reset names the browser file',
        ['anon.png']],
    ['05', 'me-named.pdf', 'CONTROL a PDF whose preview is named: the reset names the file and its preview',
        ['me-named.pdf', 'staged-me-named.pdf-preview.png']],
    ['06', 'me.png', 'CONTROL an image with no preview: the reset names the file',
        ['me.png']]
];

test.describe('#B1027 a reset names no file « undefined »', () => {

    for (const [num, name, label, files] of ARMS) {
        test(num + ' ' + label, async ({ page: pw }) => {
            const log = await open(pw, page(INPUT));
            await select(pw, log, name);
            const atStaging = await namedUndefined(pw);
            await reset(pw, log);
            expect({
                removal: log.remove,
                callback: await pw.evaluate(() => window.__resets),
                namedUndefined: atStaging,
                imagesLeft: await pw.locator('#docA-preview img').count()
            }).toEqual({
                removal: ['POST ' + JSON.stringify({ files: files })],
                callback: [files],
                namedUndefined: [],
                imagesLeft: 0
            });
            expect(log.errors).toEqual([]);
        });
    }
});
