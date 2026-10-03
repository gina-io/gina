'use strict';

/**
 * #B729 — choosing another file while the input's staging request is still on the wire. Once
 * every request has settled, the hidden metadata must describe the file the input shows.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64=; the test holds each staging request and releases it with metadata naming the
 * file that request carried, so the reader can tell which selection filled the form.
 *
 * RED-FIRST, measured 2026-10-02 on the committed dist of develop `761631fb4` (arm 03 on the next
 * build, before this fix): the second selection was never sent, the form kept the first file's
 * metadata (`one.png`) while the input showed `two.png`, and the waiting submit posted `one.png`;
 * the control passed. Green after the rebuild.
 *
 *   01 CONTROL a second file chosen after the first upload settled: staged, the metadata follows
 *   02 a second file chosen while the first upload is held: it is staged too, and the metadata
 *      describes it once everything has settled
 *   03 a submit waiting for the first upload (#B726), then a second file chosen during the wait:
 *      the submit is sent once, with the second file's metadata
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-reselect-b729.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload reselect</title>'
    + '<link rel="icon" href="data:,">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>'
    + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">'
    + '<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage"'
    + ' data-gina-form-upload-preview="docA-preview" data-gina-form-upload-error="docA-error">'
    + '<ul id="docA-preview"></ul><p id="docA-error" hidden></p>'
    + '<button id="b459form-submit" type="submit">Save</button></form></body></html>';

/** The file name a staging request carries (its multipart part's filename). */
function stagedName(request) {
    const buf = request.postDataBuffer();
    const m = buf ? /filename="([^"]+)"/.exec(buf.toString('latin1')) : null;
    return m ? m[1] : null;
}

/** A staging answer whose metadata names `name`. */
function echo(name) {
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{
        name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/' + name, mime: 'image/png', tmpUri: '/upload-tmp/' + name }] }) };
}

/** Holds every staging request; `release(i)` answers request i with metadata naming its own file. */
function holdStaging(pw) {
    const ctl = { names: [], pending: [] };
    pw.route('**/upload-stage', async (route) => {
        const name = stagedName(route.request());
        ctl.names.push(name);
        await new Promise((resolve) => ctl.pending.push(resolve));
        // a superseded request may already be gone when its turn comes: that is not this test's subject
        await route.fulfill(echo(name)).catch(() => {});
    });
    ctl.release = (i) => { if (ctl.pending[i]) { ctl.pending[i](); } };
    return ctl;
}

async function boot(pw) {
    const sink = { errors: [] };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    const ctl = holdStaging(pw);
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(PAGE, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    return { sink, ctl };
}

const stage = (pw, file) => pw.setInputFiles('#docA', { name: file, mimeType: 'image/png', buffer: PNG });

/** Records every save POST's body. */
function countSaves(pw) {
    const saves = { n: 0, bodies: [] };
    pw.on('request', (r) => { if (r.url().indexOf('/upload-save') > -1 && r.method() === 'POST') { saves.n++; saves.bodies.push(r.postData() || ''); } });
    return saves;
}

/** What the form holds now: the file the input shows and the metadata its hidden fields carry. */
function observe(pw) {
    return pw.evaluate(() => {
        const v = (k) => { const el = document.querySelector('#b459form input[name="doc[0][' + k + ']"]'); return el ? el.value : null; };
        const input = document.getElementById('docA');
        return { shown: (input.files && input.files[0]) ? input.files[0].name : null, originalFilename: v('originalFilename'), location: v('location') };
    });
}

function filledWith(pw, file) {
    return pw.waitForFunction((n) => {
        const el = document.querySelector('#b459form input[name="doc[0][originalFilename]"]');
        return !!(el && el.value === n);
    }, file, { timeout: 5000 }).then(() => true).catch(() => false);
}

test.describe('#B729 — a file chosen while the previous one is still staging', () => {

    test('01 CONTROL a second file chosen after the first upload settled is staged and described', async ({ page: pw }) => {
        const { sink, ctl } = await boot(pw);
        await stage(pw, 'one.png');
        await expect.poll(() => ctl.names.length, { timeout: 5000 }).toBe(1);
        ctl.release(0);
        expect(await filledWith(pw, 'one.png'), 'reader check: the first upload fills the form').toBe(true);
        await pw.waitForTimeout(300);
        await stage(pw, 'two.png');
        await expect.poll(() => ctl.names.length, { timeout: 5000 }).toBe(2);
        ctl.release(1);
        await filledWith(pw, 'two.png');
        expect({ staged: ctl.names.slice(), ...(await observe(pw)), errors: sink.errors.slice() }).toEqual({
            staged: ['one.png', 'two.png'], shown: 'two.png', originalFilename: 'two.png', location: '/tmp/uploads/two.png', errors: []
        });
    });

    test('02 a second file chosen while the first is held is staged too, and the metadata describes it', async ({ page: pw }) => {
        const { sink, ctl } = await boot(pw);
        await stage(pw, 'one.png');
        await expect.poll(() => ctl.names.length, { timeout: 5000 }).toBe(1);
        await stage(pw, 'two.png');
        await pw.waitForTimeout(600);
        ctl.release(0);
        // a fix may supersede the first request or send the second after it: wait for either
        await expect.poll(() => ctl.names.length, { timeout: 4000 }).toBeGreaterThan(1).catch(() => {});
        for (let i = 1; i < ctl.names.length; i++) { ctl.release(i); }
        await filledWith(pw, 'two.png');
        await pw.waitForTimeout(400);
        const seen = { staged: ctl.names.slice(), ...(await observe(pw)), errors: sink.errors.slice() };
        // the first request may or may not reach the route before a fix supersedes it: only the
        // second selection's request is required
        expect({ stagedTwo: seen.staged.indexOf('two.png') > -1, shown: seen.shown, originalFilename: seen.originalFilename,
            location: seen.location, errors: seen.errors }, 'staged: ' + JSON.stringify(seen.staged)).toEqual({
            stagedTwo: true, shown: 'two.png', originalFilename: 'two.png', location: '/tmp/uploads/two.png', errors: [] });
    });

    test('03 a submit waiting for the first upload, then a second file chosen: one save, with the second file', async ({ page: pw }) => {
        const { sink, ctl } = await boot(pw);
        const saves = countSaves(pw);
        await stage(pw, 'one.png');
        await expect.poll(() => ctl.names.length, { timeout: 5000 }).toBe(1);
        await pw.click('#b459form-submit');
        await pw.waitForTimeout(400);
        const savedWhileHeld = saves.n;
        await stage(pw, 'two.png');
        await expect.poll(() => ctl.names.length, { timeout: 3000 }).toBeGreaterThan(1).catch(() => {});
        for (let i = 0; i < ctl.names.length; i++) { ctl.release(i); }
        await expect.poll(() => saves.n, { timeout: 5000 }).toBeGreaterThan(0).catch(() => {});
        await pw.waitForTimeout(600);
        const body = saves.bodies[0] || '';
        expect({ savedWhileHeld: savedWhileHeld, saves: saves.n, withTwo: body.indexOf('/tmp/uploads/two.png') > -1,
            withOne: body.indexOf('/tmp/uploads/one.png') > -1, errors: sink.errors.slice() }, 'staged: ' + JSON.stringify(ctl.names))
            .toEqual({ savedWhileHeld: 0, saves: 1, withTwo: true, withOne: false, errors: [] });
    });
});
