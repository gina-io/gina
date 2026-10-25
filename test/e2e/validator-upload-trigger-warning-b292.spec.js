'use strict';

/**
 * #B292 — the validator warned « did not find `upload <reset|delete> trigger` » where nothing was missing:
 * at the first selection of every upload input, for the reset control gina itself creates when the staging
 * succeeds, and on a re-bind (`$forms[id].reBind()`) for a saved file's delete link it had bound the first
 * time. It now warns only when the page had to provide the trigger: a delete link, or an id declared through
 * `data-gina-form-upload-<reset|delete>-trigger`.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). Each page rides /x76-page?b64=
 * with the b459 rules whisper; each staging answer is route-fulfilled, naming the file the request carried.
 * A console.warn wrapper installed before the page's scripts records each warning carrying the needle, with
 * whether the element it names exists at that moment and its `isBinded` flag.
 *
 *   01 a default reset control: select, reset, select again — no warning
 *   02 two selections without a reset — no warning
 *   03 CONTROL a declared reset trigger the page holds — no warning, and it removes the file
 *   04 CONTROL an edit form whose saved file has its delete link — no warning, and it deletes
 *   05 CONTROL an edit form whose saved file has NO delete link — one warning naming that link
 *   06 an edit form re-bound with reBind(): its delete link is found and bound — no warning, and the
 *      delete sends one request
 *   07 a staged file, then reBind() — no warning at the selection
 *   08 no preview container — no warning at the selection or at the staging success
 *   09 CONTROL a declared reset trigger id with no element — one warning naming the declared id
 *
 * Not asserted, deliberately: arm 07's warning at the re-bind, where bindForm reads the staged preview as a
 * saved file and looks for its delete link (#B990, filed on its own).
 *
 * RED-FIRST, measured 2026-10-25 on the committed dist of develop `7acd7622f` served through
 * B292_PREFIX_BUNDLE=<path to that gina.min.js> (page.route, nothing written to disk; `routeHits` proves the
 * old bytes ran): the four CONTROL arms (03, 04, 05, 09) pass and every other arm fails on its warning
 * assertion. Green after the rebuild.
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-trigger-warning-b292.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload trigger warning</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

/** The warning's fixed head. */
const NEEDLE = 'did not find `upload';

/** The staging answer for `name`, an image. */
function image(name) {
    return { name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-' + name, mime: 'image/png', tmpUri: '/upload-tmp/staged-' + name };
}

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

/** An edit form's saved file: its hidden fields and its preview, with or without its delete link. */
function savedFile(withLink) {
    return '<input type="hidden" name="doc[0][name]" value="photo.png"><input type="hidden" name="doc[0][location]" value="/media/stored/photo.png">'
        + '<div id="docA-preview"><img src="/upload-tmp/photo.png" alt="">'
        + (withLink ? '<a href="#" id="docA-0-delete-trigger">Delete</a>' : '') + '</div>';
}

/**
 * Routes the bundle (red-first seam), the staging and removal answers, installs the warning probe and
 * records the requests and page errors, then loads `html`.
 */
async function open(pw, html) {
    const log = { stage: [], remove: [], errors: [], routeHits: 0, phase: 'load', warnings: [] };
    if (process.env.B292_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B292_PREFIX_BUNDLE);
        await pw.route('**/js/gina.min.js', async (route) => {
            log.routeHits++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await pw.route('**/upload-stage', async (route) => {
        const s = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1');
        const names = [];
        const re = /filename="([^"]+)"/g;
        let m;
        while ((m = re.exec(s))) { names.push(m[1]); }
        await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: names.map(image) }) });
    });
    await pw.route('**/upload-unstage**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    pw.on('pageerror', (e) => log.errors.push(String((e && e.message) || e)));
    pw.on('request', (r) => {
        const u = r.url();
        if (u.indexOf('/upload-stage') > -1) { log.stage.push(r.method()); }
        if (u.indexOf('/upload-unstage') > -1) { log.remove.push(r.method() + ' ' + (r.postData() || '')); }
    });
    await pw.addInitScript((needle) => {
        window.__warnings = [];
        var warn = console.warn;
        console.warn = function () {
            try {
                var t = String(arguments[0]);
                if (t.indexOf(needle) > -1) {
                    var m = t.match(/element ID is `([^`]+)`/);
                    var id = m ? m[1] : null;
                    var el = id ? document.getElementById(id) : null;
                    window.__warnings.push({ id: id, present: !!el, isBinded: el ? String(el.isBinded) : null });
                }
            } catch (e) { /* the probe never breaks the page */ }
            return warn.apply(console, arguments);
        };
    }, NEEDLE);
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    return log;
}

/** Waits until the validator has bound both forms. */
function ready(pw) {
    return pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form']
        && window.gina.validator.$forms['b459declared']), null, { timeout: 15000 });
}

/** Resolves once the field `name` of b459form holds `value`; false after the timeout. */
function filled(pw, name, value) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: 6000 }).then(() => true, () => false);
}

/** Selects `name` in the file input, then waits for the staging request and its fill. */
async function select(pw, log, name) {
    const before = log.stage.length;
    await pw.setInputFiles('#docA', { name: name, mimeType: 'image/png', buffer: PNG });
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    return filled(pw, 'doc[0][location]', '/tmp/uploads/staged-' + name);
}

/**
 * Waits `ms`, then tags the warnings the page recorded since the last call with the current phase, and
 * returns them all as `phase:id:present|absent`.
 */
async function settle(pw, log, ms) {
    await pw.waitForTimeout(ms || 400);
    const arr = await pw.evaluate(() => window.__warnings || []);
    for (let i = log.warnings.length; i < arr.length; i++) { log.warnings.push(Object.assign({ phase: log.phase }, arr[i])); }
    return log.warnings.map((w) => w.phase + ':' + w.id + ':' + (w.present ? 'present' : 'absent'));
}

/** Calls reBind() on form b459form. */
function reBind(pw) {
    return pw.evaluate(() => { try { window.gina.validator.$forms['b459form'].reBind(); return 'ok'; } catch (e) { return 'threw: ' + e.message; } });
}

/** The checks every arm makes: the seam served, no uncaught error. */
function common(log) {
    if (process.env.B292_PREFIX_BUNDLE) { expect(log.routeHits, 'the pre-fix bundle was not served').toBeGreaterThan(0); }
    expect(log.errors, 'uncaught exception on the page').toEqual([]);
}

test.describe('#B292 upload reset/delete trigger warning', () => {

    test('01 a default reset control: select, reset, select again — no warning', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        await settle(pw, log);
        log.phase = 'reset';
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        await settle(pw, log);
        log.phase = 'select2';
        expect(await select(pw, log, 'you.png')).toBe(true);
        expect(await settle(pw, log), 'the shipped bundle warned for the reset control gina creates at the staging success').toEqual([]);
        common(log);
    });

    test('02 two selections without a reset — no warning', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        await settle(pw, log);
        log.phase = 'select2';
        expect(await select(pw, log, 'you.png')).toBe(true);
        expect(await settle(pw, log)).toEqual([]);
        common(log);
    });

    test('03 CONTROL a declared reset trigger the page holds — no warning, and it removes the file', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" data-gina-form-upload-reset-trigger="myReset" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><button type="button" id="myReset">Reset</button><p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        await settle(pw, log);
        log.phase = 'reset';
        await pw.click('#myReset');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(await settle(pw, log)).toEqual([]);
        common(log);
    });

    test('04 CONTROL an edit form whose saved file has its delete link — no warning, and it deletes', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + savedFile(true)
            + '<p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log);
        log.phase = 'delete';
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(await settle(pw, log)).toEqual([]);
        common(log);
    });

    test('05 CONTROL an edit form whose saved file has NO delete link — one warning naming that link', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + savedFile(false)
            + '<p id="docA-error" hidden></p>'));
        await ready(pw);
        expect(await settle(pw, log)).toEqual(['load:docA-0-delete-trigger:absent']);
        common(log);
    });

    test('06 an edit form re-bound with reBind(): no warning, and the delete sends one request', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + savedFile(true)
            + '<p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log);
        log.phase = 'rebind';
        expect(await reBind(pw)).toBe('ok');
        expect(await settle(pw, log), 'the shipped bundle warned « did not find » for a link that is present and bound').toEqual([]);
        log.phase = 'delete';
        await pw.click('#docA-0-delete-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        await settle(pw, log);
        expect(log.remove.length, 'the link was not bound a second time').toBe(1);
        common(log);
    });

    test('07 a staged file, then reBind() — no warning at the selection', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        expect(await settle(pw, log)).toEqual([]);
        log.phase = 'rebind';
        expect(await reBind(pw)).toBe('ok');
        await settle(pw, log);
        log.phase = 'reset';
        await pw.click('#docA-0-reset-trigger');
        await expect.poll(() => log.remove.length).toBe(1);
        expect(log.remove[0]).toBe('POST {"files":["me.png"]}');
        common(log);
    });

    test('08 no preview container — no warning at the selection or at the staging success', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
            + '<p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        expect(await settle(pw, log, 500)).toEqual([]);
        common(log);
    });

    test('09 CONTROL a declared reset trigger id with no element — one warning naming the declared id', async ({ page: pw }) => {
        const log = await open(pw, page('<input id="docA" type="file" name="doc" data-gina-form-upload-reset-trigger="noSuchReset" ' + ACTIONS + '>'
            + '<div id="docA-preview"></div><p id="docA-error" hidden></p>'));
        await ready(pw); await settle(pw, log, 300);
        log.phase = 'select1';
        expect(await select(pw, log, 'me.png')).toBe(true);
        expect(await settle(pw, log, 500)).toEqual(['select1:noSuchReset:absent']);
        common(log);
    });
});
