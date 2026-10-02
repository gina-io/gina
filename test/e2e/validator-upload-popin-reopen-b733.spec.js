'use strict';

/**
 * #B733 — a staged upload in a form that an AJAX popin loaded, after the popin was closed and
 * opened again: the new selection must be staged from the reopened form and fill its metadata.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64= so its staging requests reach the harness; the popin body is page.route'd and
 * the staging route answers with metadata naming the file each request carried. The popin is
 * registered WITH the validator and opened through a LEGACY trigger: only that path binds a form
 * loaded into a popin (test/core/popin-forms-teardown.test.js; the popin guide, « Forms inside
 * popins »). A registration rewrites a legacy trigger's id, so the trigger is selected by its
 * `data-gina-popin-name`; `data-gina-dialog-preload="false"` makes every open a click-time load.
 *
 * RED-FIRST, measured 2026-10-02 on the committed dist of develop `761631fb4`: after the close
 * and reopen, arms 02 and 03 threw `setAttribute is not a function` (the validator record of the
 * earlier virtual form was used as the form element) and sent no staging request, and the reopened
 * upload never reached the declared on-success callback; the control passed. Green after the rebuild.
 *
 *   01 CONTROL first open: one staging POST carrying the popin id, the metadata fills
 *   02 closed with its close button, reopened: the new selection is staged from the new form
 *   03 the same, closed through the popin's own close(): getPopinByName(name).close()
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-popin-reopen-b733.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// the b459 whisper (non-empty: the validator boots), no page form, one legacy trigger
// The on-success callback is declared by the popin's file input and must exist before the
// first staging send (the validator reads `window[name]` when it binds the virtual form).
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload popin reopen</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script>window.__ok = 0; window.onUplOk = function () { window.__ok++; };</script>'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body><h1>upload popin reopen</h1>'
    + '<button data-gina-popin-name="upl" data-gina-popin-url="/frag/upl.html" data-gina-dialog-preload="false">Open</button>'
    + '</body></html>';

// the popin body: rule b459form (title isRequired, pre-filled), one staged input, a close button
const FRAG = '<div id="upl-frag">'
    + '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">'
    + '<input id="docA" type="file" name="doc" data-gina-form-upload-action="/upload-stage"'
    + ' data-gina-form-upload-preview="docA-preview" data-gina-form-upload-error="docA-error"'
    + ' data-gina-form-upload-on-success="onUplOk">'
    + '<ul id="docA-preview"></ul><p id="docA-error" hidden></p>'
    + '<button id="b459form-submit" type="submit">Save</button></form>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';

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

/** Wire the sinks, load the page, register popin `upl` with the validator. */
async function boot(pw) {
    const sink = { errors: [], warnings: [], frag: 0, stage: [] };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    pw.on('console', (m) => { if (m.type() === 'warning') sink.warnings.push(m.text()); });
    await pw.route('**/upload-stage', (route) => {
        const h = route.request().headers();
        const name = stagedName(route.request());
        sink.stage.push({ name: name, popinId: h['x-gina-popin-id'] || null });
        return route.fulfill(echo(name));
    });
    await pw.route('**/frag/upl.html', (route) => {
        sink.frag++;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAG });
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(PAGE, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.hasPopinHandler === true && window.gina.validator), null, { timeout: 15000 });
    const reg = await pw.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'upl', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'popin upl must register').toBe('READY');
    return sink;
}

/** Open through the legacy trigger; returns the popin id. */
async function openPopin(pw) {
    await pw.click('[data-gina-popin-name="upl"]');
    await pw.waitForFunction(() => {
        const p = window.gina.popin.getPopinByName('upl');
        const f = document.getElementById('b459form');
        return !!(p && p.isOpen && f && f.closest('dialog'));
    }, null, { timeout: 8000 });
    await pw.waitForTimeout(400);
    return pw.evaluate(() => window.gina.popin.getPopinByName('upl').id);
}

/** Is the validator entry for b459form the LIVE node? (a stale entry also passes an existence check) */
function boundToLiveNode(pw) {
    return pw.evaluate(() => {
        const f = window.gina.validator.$forms && window.gina.validator.$forms['b459form'];
        return !!(f && f.target && f.target === document.getElementById('b459form'));
    });
}

const stage = (pw, file) => pw.setInputFiles('#docA', { name: file, mimeType: 'image/png', buffer: PNG });

/** Wait until the live form's metadata names `file`; false on timeout, never a throw. */
function filledWith(pw, file) {
    return pw.waitForFunction((n) => {
        const el = document.querySelector('#b459form input[name="doc[0][originalFilename]"]');
        return !!(el && el.value === n);
    }, file, { timeout: 5000 }).then(() => true).catch(() => false);
}

const CLOSERS = {
    button: async (pw) => { await pw.click('dialog .gina-popin-close', { force: true }); },
    own:    async (pw) => { await pw.evaluate(() => { window.gina.popin.getPopinByName('upl').close(); }); }
};

async function closePopin(pw, how) {
    await CLOSERS[how](pw);
    await pw.waitForFunction(() => !window.gina.popin.getPopinByName('upl').isOpen, null, { timeout: 5000 });
    await pw.waitForTimeout(400);
}

/** First open + one staged file, close it `how`, reopen, stage another; returns what was seen. */
async function reopenScene(pw, how) {
    const sink = await boot(pw);
    await openPopin(pw);
    await stage(pw, 'one.png');
    await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(1);
    expect(await filledWith(pw, 'one.png'), 'scene premise: the first open stages and fills').toBe(true);
    await closePopin(pw, how);
    const liveAfterClose = await boundToLiveNode(pw);
    const popinId = await openPopin(pw);
    const bound = await boundToLiveNode(pw);
    await stage(pw, 'two.png');
    const filled = await filledWith(pw, 'two.png');
    await pw.waitForTimeout(300);
    return {
        seen: { frag: sink.frag, liveAfterClose: liveAfterClose, boundOnReopen: bound,
            staged: sink.stage.map((s) => s.name), secondFromPopin: !!(sink.stage[1] && sink.stage[1].popinId === popinId),
            filled: filled, onSuccessCalls: await pw.evaluate(() => window.__ok), errors: sink.errors.slice(),
            teardownWarnings: sink.warnings.filter((w) => /popin teardown/.test(w)) },
        expected: { frag: 2, liveAfterClose: false, boundOnReopen: true, staged: ['one.png', 'two.png'],
            secondFromPopin: true, filled: true, onSuccessCalls: 2, errors: [], teardownWarnings: [] }
    };
}

test.describe('#B733 — a staged upload in a reopened AJAX popin', () => {

    test('01 CONTROL first open: one staging POST from the popin, the metadata fills', async ({ page: pw }) => {
        const sink = await boot(pw);
        const popinId = await openPopin(pw);
        expect(await boundToLiveNode(pw), 'reader check: the first open IS bound (must read true)').toBe(true);
        await stage(pw, 'one.png');
        await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(1);
        expect(await filledWith(pw, 'one.png')).toBe(true);
        await expect.poll(() => pw.evaluate(() => window.__ok), { timeout: 3000 }).toBe(1);
        expect(sink.stage[0]).toEqual({ name: 'one.png', popinId: popinId });
        expect(sink.errors).toEqual([]);
    });

    test('02 closed with its close button, reopened: the new selection is staged from the new form', async ({ page: pw }) => {
        const r = await reopenScene(pw, 'button');
        expect(r.seen).toEqual(r.expected);
    });

    test('03 closed through getPopinByName(name).close(), reopened: the same', async ({ page: pw }) => {
        const r = await reopenScene(pw, 'own');
        expect(r.seen).toEqual(r.expected);
    });
});
