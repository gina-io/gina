'use strict';

/**
 * #B758 — a staged upload's `send()` reads nothing from the implicit global `event`.
 *
 * A file input with `data-gina-form-upload-action` stages its files through a virtual upload
 * form (`gina.validator.$forms['gina-upload-…']`). Its `send()` read the upload group from
 * `event.currentTarget` and, when called with no data, its payload from `event.detail.data`,
 * where `event` was the implicit global: the event being dispatched when `send()` runs. The
 * picker and the dropzone call `send()` inside the input's own change dispatch, so they were
 * fine (test 01). A direct call on the virtual form was not:
 *   - outside any dispatch, the group read threw a TypeError, reported as a staging error, and
 *     the request still went out as `multipart/form-data` with no boundary and no group;
 *   - inside an unrelated dispatch, the group was read from that event's element, silently;
 *   - with no data, the payload read threw out of `send()` after `isSending` was claimed, so the
 *     form stayed in sending.
 * The group now comes from the file input the virtual form stages for, and a no-data `send()`
 * takes the empty-body branch. The documented `$forms[id].send(FormData)` on a real form never
 * reached these reads and is unchanged (test 05).
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist) on a page that rides
 * /x76-page?b64= with the b459 whisper, so the validator boots. The staging and save routes are
 * answered by the spec.
 *
 *   01 CONTROL a real selection stages one request in the input's group
 *   02 send(FormData) on the virtual form outside any dispatch: no error, the input's group
 *   03 the same call inside an unrelated click dispatch: still the input's group
 *   04 send() with no data on the virtual form outside any dispatch: no throw, not left sending
 *   05 SCOPE the documented send(FormData) on the real form: one save request, no staging
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-send-b758.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// the input's error callback records what it is called with; __png() builds a File in the page
const HEAD_SCRIPT = '<script>window.__errCalls = []; window.onUplErr = function () {'
    + ' window.__errCalls.push(Array.prototype.map.call(arguments, function (a) {'
    + ' return (a && a.message) ? "msg:" + a.message : (a && a.type) ? "event:" + a.type : String(a); })); };'
    + ' window.__png = function () { var b = atob("' + PNG_B64 + '"); var u = new Uint8Array(b.length);'
    + ' for (var i = 0; i < b.length; i++) { u[i] = b.charCodeAt(i); } return u; };</script>';

// an unrelated button, carrying a group of its own, whose click listener calls the virtual form's send()
const BODY_SCRIPT = '<script>document.getElementById("unrelated").addEventListener("click", function () {'
    + ' var vid = document.getElementById("docA").getAttribute("data-gina-form-virtual");'
    + ' var fd = new FormData(); fd.append("doc", new File([window.__png()], "three.png", { type: "image/png" }));'
    + ' try { window.gina.validator.$forms[vid].send(fd, { withCredentials: true }); window.__clickThrew = null; }'
    + ' catch (e) { window.__clickThrew = String((e && e.message) || e); } });</script>';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b758</title>'
    + '<link rel="icon" href="data:,">' + HEAD_SCRIPT
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>'
    + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">'
    + '<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage"'
    + ' data-gina-form-upload-group="avatars" data-gina-form-upload-preview="docA-preview"'
    + ' data-gina-form-upload-error="docA-error" data-gina-form-upload-on-error="onUplErr">'
    + '<ul id="docA-preview"></ul><p id="docA-error" hidden></p>'
    + '<button id="b459form-submit" type="submit">Save</button></form>'
    + '<button id="unrelated" type="button" data-gina-form-upload-group="from-button">Unrelated</button>'
    + BODY_SCRIPT + '</body></html>';

/** The `filename` of the first part of a multipart body, or null. */
function stagedName(buf) {
    const m = buf ? /filename="([^"]+)"/.exec(buf.toString('latin1')) : null;
    return m ? m[1] : null;
}

/** A staging answer echoing the staged file. */
function echo(name) {
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{
        name: 'staged-' + name, group: 'avatars', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/' + name, mime: 'image/png', tmpUri: '/upload-tmp/' + name }] }) };
}

/** Wire the staging and save routes, load the page, wait for the validator. */
async function boot(pw) {
    const sink = { errors: [], stage: [], save: [] };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    await pw.route('**/upload-stage', (route) => {
        const req = route.request();
        const buf = req.postDataBuffer();
        const body = buf ? buf.toString('latin1') : '';
        sink.stage.push({ ct: req.headers()['content-type'] || null, filename: stagedName(buf),
            groups: (body.match(/group="[^"]*"/g) || []), bytes: buf ? buf.length : 0 });
        return route.fulfill(echo(stagedName(buf) || 'unknown'));
    });
    await pw.route('**/upload-save', (route) => {
        const req = route.request();
        const buf = req.postDataBuffer();
        sink.save.push({ ct: req.headers()['content-type'] || null, bytes: buf ? buf.length : 0 });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(PAGE, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    return sink;
}

/** A real selection through the picker: the path that builds the virtual form. */
async function selectOne(pw, sink) {
    await pw.setInputFiles('#docA', { name: 'one.png', mimeType: 'image/png', buffer: PNG });
    await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => isSending(pw), { timeout: 5000 }).toBe(false);
}

/** The virtual form's `isSending`, as a boolean (null when there is no virtual form). */
function isSending(pw) {
    return pw.evaluate(() => {
        const vid = document.getElementById('docA').getAttribute('data-gina-form-virtual');
        const vf = vid && window.gina.validator.$forms[vid];
        return vf ? /^true$/i.test(vf.isSending) : null;
    });
}

/** The input's error-callback calls. */
function errCalls(pw) {
    return pw.evaluate(() => window.__errCalls.slice());
}

test.describe('#B758 — a staged upload\'s send() reads nothing from the global event', () => {

    test('01 CONTROL a real selection stages one request in the input\'s group', async ({ page: pw }) => {
        const sink = await boot(pw);
        await selectOne(pw, sink);
        expect(sink.stage[0].filename).toBe('one.png');
        expect(sink.stage[0].ct).toMatch(/^multipart\/form-data; boundary=/);
        expect(sink.stage[0].groups).toEqual(['group="avatars"']);
        expect(await errCalls(pw)).toEqual([]);
        expect(sink.errors).toEqual([]);
    });

    test('02 send(FormData) on the virtual form outside any dispatch: no error, the input\'s group', async ({ page: pw }) => {
        const sink = await boot(pw);
        await selectOne(pw, sink);
        const call = await pw.evaluate(() => {
            const vid = document.getElementById('docA').getAttribute('data-gina-form-virtual');
            const fd = new FormData();
            fd.append('doc', new File([window.__png()], 'two.png', { type: 'image/png' }));
            const out = { windowEvent: typeof window.event, threw: null };
            try { window.gina.validator.$forms[vid].send(fd, { withCredentials: true }); }
            catch (e) { out.threw = String((e && e.message) || e); }
            return out;
        });
        expect(call).toEqual({ windowEvent: 'undefined', threw: null });
        await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(2);
        expect(sink.stage[1].filename).toBe('two.png');
        expect(sink.stage[1].ct).toMatch(/^multipart\/form-data; boundary=/);
        expect(sink.stage[1].groups).toEqual(['group="avatars"']);
        await expect.poll(() => isSending(pw), { timeout: 5000 }).toBe(false);
        expect(await errCalls(pw)).toEqual([]);
        expect(sink.errors).toEqual([]);
    });

    test('03 the same call inside an unrelated click dispatch: still the input\'s group', async ({ page: pw }) => {
        const sink = await boot(pw);
        await selectOne(pw, sink);
        await pw.click('#unrelated');
        await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(2);
        expect(sink.stage[1].filename).toBe('three.png');
        expect(sink.stage[1].groups).toEqual(['group="avatars"']);
        expect(await pw.evaluate(() => window.__clickThrew)).toBe(null);
        await expect.poll(() => isSending(pw), { timeout: 5000 }).toBe(false);
        expect(await errCalls(pw)).toEqual([]);
        expect(sink.errors).toEqual([]);
    });

    test('04 send() with no data on the virtual form outside any dispatch: no throw, not left sending', async ({ page: pw }) => {
        const sink = await boot(pw);
        await selectOne(pw, sink);
        const threw = await pw.evaluate(() => {
            const vid = document.getElementById('docA').getAttribute('data-gina-form-virtual');
            try { window.gina.validator.$forms[vid].send(); return null; }
            catch (e) { return String((e && e.message) || e); }
        });
        expect(threw).toBe(null);
        // the empty-body branch: one more staging request, with no body
        await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(2);
        expect(sink.stage[1].bytes).toBe(0);
        await expect.poll(() => isSending(pw), { timeout: 5000 }).toBe(false);
        expect(sink.errors).toEqual([]);
    });

    test('05 SCOPE the documented send(FormData) on the real form: one save request, no staging', async ({ page: pw }) => {
        const sink = await boot(pw);
        const threw = await pw.evaluate(() => {
            try { window.gina.validator.$forms['b459form'].send(new FormData(document.getElementById('b459form'))); return null; }
            catch (e) { return String((e && e.message) || e); }
        });
        expect(threw).toBe(null);
        await expect.poll(() => sink.save.length, { timeout: 5000 }).toBe(1);
        await pw.waitForTimeout(400);
        expect(sink.stage).toEqual([]);
        expect(await errCalls(pw)).toEqual([]);
        expect(sink.errors).toEqual([]);
    });
});
