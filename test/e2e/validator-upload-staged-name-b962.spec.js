'use strict';

/**
 * #B962 — a successful staging fills the `[name]` field from its answer, like every other key.
 *
 * The staging success fills the form's hidden fields from the answer, one key at a time, and skipped
 * `name` whenever its field already held a value. So a replacement in an edit form, whose `[name]` the
 * page declares with the saved file's name, saved that name beside the new file's location and
 * original filename, and a second selection on the same input saved the first staged file's name.
 * Since the fix the answer's `name` fills the field like every other key; an answer that carries no
 * `name` leaves the field as it is.
 *
 *   C1 CONTROL  an edit form, no selection: the save posts the saved file
 *   C2 CONTROL  an edit form, an answer without a name: the save posts the saved name beside the
 *               staged file's location and original filename
 *   C3 CONTROL  a fresh form, one staging: the save posts the answer's name
 *   C4 CONTROL  an edit form that also declares `[id]`: a replacement whose answer carries no `id`
 *               leaves it, so the save posts the declared id beside the staged file
 *   N1  an edit form, a successful replacement: the save posts the staged file's name
 *   N2  a fresh form, two successful stagings: the save posts the second staged file's name
 *
 * The staging route answers from each arm's plan, in request order, and never reads the request
 * body: on WebKit a route handler reads no multipart body.
 *
 * RED-FIRST: B962_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves the old bytes to every arm
 * (page.route, nothing written to disk; C1 to C4 assert that the swap ran). N1 and N2 fail on a
 * bundle without the fix, each on its saved name; C1 to C4 pass on both.
 *
 * Run (local, cached headless shell; WebKit: GINA_E2E_ENGINES=all ... --project=webkit, on its own port):
 *   GINA_E2E_PORT=3297 PW_CHROME=<chrome-headless-shell> npx playwright test \
 *     test/e2e/validator-upload-staged-name-b962.spec.js --project=chromium
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload b962</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>';

const ACTIONS = 'data-gina-form-upload-action="/upload-stage" data-gina-form-upload-reset-action="/upload-unstage"'
    + ' data-gina-form-upload-delete-action="/upload-unstage"';

const FORM_OPEN = '<form id="b459form" data-gina-form-rule="b459form" action="/upload-save" method="post">'
    + '<input id="titleA" type="text" name="title" value="t">';
const FORM_CLOSE = '<button id="b459form-submit" type="submit">Save</button></form>';
const DECLARED = '<form id="b459declared" data-gina-form-rule="b459declared" action="/upload-save" method="post">'
    + '<input type="text" name="title" value="d"><button type="submit">Save</button></form>';

const STORED = '<input type="hidden" name="doc[0][name]" value="old.png">'
    + '<input type="hidden" name="doc[0][location]" value="/media/stored/old.png">';
const EDIT = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>' + STORED
    + '<div id="docA-preview"><img src="/upload-tmp/old.png" data-upload-original-filename="old.png" alt=""></div>'
    + '<div><a href="#" id="docA-0-delete-trigger">Delete</a></div><p id="docA-error" hidden></p>';
const FRESH = '<input id="docA" type="file" name="doc" ' + ACTIONS + '>'
    + '<div id="docA-preview"></div><p id="docA-error" hidden></p>';
const EDIT_ID = EDIT + '<input type="hidden" name="doc[0][id]" value="42">';

function page(inner) { return HEAD + FORM_OPEN + inner + FORM_CLOSE + DECLARED + '</body></html>'; }
function file(name) { return { name: name, mimeType: 'image/png', buffer: PNG }; }

/**
 * The staging answer for one file, as the upload action would answer it.
 *
 * @param {string} name - the file's name
 * @param {boolean} [withName=true] - false leaves `name` out, as the answer the guide documents
 * @returns {object} the file's staging metadata
 */
function answer(name, withName) {
    const a = { name: 'staged-' + name, group: 'untagged', originalFilename: name, ext: 'png', encoding: '7bit',
        size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-' + name, mime: 'image/png', tmpUri: '/upload-tmp/staged-' + name };
    if (withName === false) { delete a.name; }
    return a;
}

/**
 * The staging route of one arm: the Nth staging request gets the plan's Nth step, never an answer
 * read from the request body. A step is `{ ok: <file name> }`, plus `noName: true` for an answer
 * without its `name` key.
 *
 * @param {Array<object>} plan - the arm's steps, in request order
 * @param {object} log - the arm's record (`answered` counts the answers sent)
 * @returns {Function} the route handler
 */
function stager(plan, log) {
    let next = 0;
    return async (route) => {
        const step = plan[next++];
        if (!step) {
            log.unplanned++;
            return route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8',
                body: JSON.stringify({ status: 500, error: 'no step planned' }) });
        }
        log.answered++;
        return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ files: [answer(step.ok, !step.noName)] }) });
    };
}

async function open(pw, html, plan) {
    const log = { stage: [], saves: [], errors: [], routeHits: 0, answered: 0, unplanned: 0 };
    if (process.env.B962_PREFIX_BUNDLE) {
        const body = require('fs').readFileSync(process.env.B962_PREFIX_BUNDLE);
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
        if (u.indexOf('/upload-save') > -1 && r.method() === 'POST') { log.saves.push(r.postData() || ''); }
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(html, 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms.b459form), null, { timeout: 15000 });
    return log;
}

function filled(pw, name, value, timeout) {
    return pw.waitForFunction(([n, v]) => {
        const el = document.querySelector('#b459form [name="' + n + '"]');
        return !!(el && el.value === v);
    }, [name, value], { timeout: timeout || 6000 }).then(() => true, () => false);
}

/** Chooses a file whose staging the plan answers: true once the answer filled its location. */
async function chooseOk(pw, log, name) {
    const before = log.stage.length;
    await pw.setInputFiles('#docA', file(name));
    await expect.poll(() => log.stage.length, { timeout: 6000 }).toBeGreaterThan(before);
    return filled(pw, 'doc[0][location]', '/tmp/uploads/staged-' + name);
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
    if (process.env.B962_PREFIX_BUNDLE) {
        expect(log.routeHits, 'the swapped bundle was served').toBeGreaterThan(0);
    }
}

/** The saved entry's name, location and original filename. */
function brief(entry) {
    return { name: entry.name, location: entry.location, originalFilename: entry.originalFilename };
}

test.describe('#B962 - a successful staging fills the [name] field from its answer', () => {

    test('C1 CONTROL - an edit form, no selection: the save posts the saved file', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT), []);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc).toEqual([{ name: 'old.png', location: '/media/stored/old.png' }]);
        expect(log.errors).toEqual([]);
        swapRan(log);
    });

    test('C2 CONTROL - an edit form, an answer without a name: the saved name stays beside the staged file', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT), [{ ok: 'new.png', noName: true }]);
        expect(await chooseOk(pw, log, 'new.png'), 'the staging filled the location').toBe(true);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc.length).toBe(1);
        expect(brief(saved.doc[0])).toEqual({ name: 'old.png', location: '/tmp/uploads/staged-new.png', originalFilename: 'new.png' });
        expect(log.unplanned).toBe(0);
        expect(log.errors).toEqual([]);
        swapRan(log);
    });

    test('C3 CONTROL - a fresh form, one staging: the save posts the answer\'s name', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ ok: 'a.png' }]);
        expect(await chooseOk(pw, log, 'a.png'), 'the staging filled the location').toBe(true);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc.length).toBe(1);
        expect(brief(saved.doc[0])).toEqual({ name: 'staged-a.png', location: '/tmp/uploads/staged-a.png', originalFilename: 'a.png' });
        expect(log.unplanned).toBe(0);
        expect(log.errors).toEqual([]);
        swapRan(log);
    });

    test('C4 CONTROL - an edit form that also declares [id]: a replacement leaves the id the answer does not carry', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT_ID), [{ ok: 'new.png' }]);
        expect(await chooseOk(pw, log, 'new.png'), 'the staging filled the location').toBe(true);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc.length).toBe(1);
        expect({ id: saved.doc[0].id, location: saved.doc[0].location }).toEqual({ id: '42', location: '/tmp/uploads/staged-new.png' });
        expect(log.unplanned).toBe(0);
        expect(log.errors).toEqual([]);
        swapRan(log);
    });

    test('N1 - an edit form, a successful replacement: the save posts the staged file\'s name', async ({ page: pw }) => {
        const log = await open(pw, page(EDIT), [{ ok: 'new.png' }]);
        expect(await chooseOk(pw, log, 'new.png'), 'the staging filled the location').toBe(true);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc.length).toBe(1);
        expect(brief(saved.doc[0])).toEqual({ name: 'staged-new.png', location: '/tmp/uploads/staged-new.png', originalFilename: 'new.png' });
        expect(log.unplanned).toBe(0);
        expect(log.errors).toEqual([]);
    });

    test('N2 - a fresh form, two successful stagings: the save posts the second staged file\'s name', async ({ page: pw }) => {
        const log = await open(pw, page(FRESH), [{ ok: 'a.png' }, { ok: 'b.png' }]);
        expect(await chooseOk(pw, log, 'a.png'), 'the first staging filled the location').toBe(true);
        expect(await chooseOk(pw, log, 'b.png'), 'the second staging filled the location').toBe(true);
        const saved = await save(pw, log);
        expect(saved.sent, 'the save was sent').toBe(true);
        expect(saved.doc.length).toBe(1);
        expect(brief(saved.doc[0])).toEqual({ name: 'staged-b.png', location: '/tmp/uploads/staged-b.png', originalFilename: 'b.png' });
        expect(log.unplanned).toBe(0);
        expect(log.errors).toEqual([]);
    });
});
