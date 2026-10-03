'use strict';

/**
 * #B731 — a staging failure must reach the declared `data-gina-form-upload-on-error` callback
 * whether or not an error element exists, and a custom `data-gina-form-upload-error` slot must be
 * honoured wherever the file input sits in its form.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64= so its staging request reaches the harness origin; the staging route answers
 * 400 (or is aborted, for the status-0 arm). The callback is defined by an inline script before
 * the bundle loads, because the validator reads `window[name]` when it binds the virtual form.
 *
 * RED-FIRST, measured 2026-10-02 on the committed dist of develop `761631fb4`: with no error
 * element (arms 02 and 05) and with a custom slot followed by another input (arm 03), the staging
 * failure threw an Error with an empty message and the declared on-error callback never ran; in
 * arm 03 the custom slot stayed empty. Both controls passed. Green after the rebuild.
 *
 *   01 CONTROL the default `<fieldId>-error` slot exists: the message shows, the callback runs
 *   02 no error element at all: the callback still runs, nothing is thrown
 *   03 a custom slot, the file input followed by another input: the message shows in that slot
 *   04 CONTROL a custom slot, the file input is the form's last input: the message shows there
 *   05 no error element, the request ends with status 0: the callback runs with transportError
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-error-slot-b731.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const REFUSED = 'upload refused';

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const CALLBACK = 'window.__errs = []; window.onUplErr = function (e, result) {'
    + ' window.__errs.push({ message: (result && (result.message || result.error)) || null,'
    + ' transportError: !!(result && result.transportError), reason: (result && result.reason) || null }); };';

/**
 * The page: one form, one staged file input that declares the on-error callback.
 * @param {{ errAttr?: string, after?: string, slots?: string }} o
 *   errAttr — the input's `data-gina-form-upload-error` value (absent when omitted);
 *   after   — markup placed right after the file input, inside the form;
 *   slots   — error elements placed at the end of the form.
 */
function page(o) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload error slot</title>'
        + '<link rel="icon" href="data:,">'
        + '<script>' + CALLBACK + '</script>'
        + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>'
        + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
        + '<input id="titleA" type="text" name="title" value="t">'
        + '<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage"'
        + ' data-gina-form-upload-preview="docA-preview" data-gina-form-upload-on-error="onUplErr"'
        + (o.errAttr ? ' data-gina-form-upload-error="' + o.errAttr + '"' : '') + '>'
        + (o.after || '')
        + '<ul id="docA-preview"></ul>'
        + (o.slots || '')
        + '<button id="b459form-submit" type="submit">Save</button>'
        + '</form></body></html>';
}

/** Wire the sinks, route the staging request, load the page and wait for the form to bind. */
async function boot(pw, o, staging) {
    const sink = { errors: [] };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e) || '(empty message)'));
    await pw.route('**/upload-stage', staging === 'abort'
        ? (route) => route.abort('connectionrefused')
        : (route) => route.fulfill({ status: 400, contentType: 'text/plain; charset=utf-8', body: REFUSED }));
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(page(o), 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
    return sink;
}

const stageFile = (pw) => pw.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });

/** What the failure left behind: the callback's calls and the text of each error element. */
function observe(pw) {
    return pw.evaluate(() => {
        const text = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
        return { calls: window.__errs.slice(), defaultSlot: text('docA-error'), customSlot: text('customErr') };
    });
}

/** Stage, let the failure settle (the callback, when it runs, runs within the settle). */
async function failAndObserve(pw, sink) {
    await stageFile(pw);
    await expect.poll(() => pw.evaluate(() => window.__errs.length), { timeout: 5000 }).toBeGreaterThan(0).catch(() => {});
    await pw.waitForTimeout(600);
    return { ...(await observe(pw)), errors: sink.errors.slice() };
}

const CALLED = (o) => [{ message: (o && o.message) || REFUSED, transportError: !!(o && o.transportError), reason: (o && o.reason) || null }];

test.describe('#B731 — a staging failure reaches the on-error callback and the declared error slot', () => {

    test('01 CONTROL the default slot exists: the message shows and the callback runs', async ({ page: pw }) => {
        const sink = await boot(pw, { slots: '<p id="docA-error" hidden></p>' });
        const seen = await failAndObserve(pw, sink);
        expect(seen).toEqual({ calls: CALLED(), defaultSlot: REFUSED, customSlot: null, errors: [] });
    });

    test('02 no error element at all: the callback still runs and nothing is thrown', async ({ page: pw }) => {
        const sink = await boot(pw, {});
        const seen = await failAndObserve(pw, sink);
        expect(seen).toEqual({ calls: CALLED(), defaultSlot: null, customSlot: null, errors: [] });
    });

    test('03 a custom slot with another input after the file input: the message shows in that slot', async ({ page: pw }) => {
        const sink = await boot(pw, {
            errAttr: 'customErr',
            after: '<input id="noteA" type="text" name="note" value="n">',
            slots: '<p id="customErr" hidden></p>'
        });
        const seen = await failAndObserve(pw, sink);
        expect(seen).toEqual({ calls: CALLED(), defaultSlot: null, customSlot: REFUSED, errors: [] });
    });

    test('04 CONTROL a custom slot, the file input is the last input: the message shows there', async ({ page: pw }) => {
        const sink = await boot(pw, { errAttr: 'customErr', slots: '<p id="customErr" hidden></p>' });
        const seen = await failAndObserve(pw, sink);
        expect(seen).toEqual({ calls: CALLED(), defaultSlot: null, customSlot: REFUSED, errors: [] });
    });

    test('05 no error element, the request ends with status 0: the callback runs with transportError', async ({ page: pw }) => {
        const sink = await boot(pw, {}, 'abort');
        const seen = await failAndObserve(pw, sink);
        expect({ calls: seen.calls.map((c) => ({ transportError: c.transportError, reason: c.reason })), errors: seen.errors })
            .toEqual({ calls: [{ transportError: true, reason: 'transport' }], errors: [] });
    });
});
