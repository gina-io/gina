'use strict';

/**
 * #B732 — two forms on one page whose staged file inputs share the same bracket-less name. Each
 * upload must fill the hidden metadata of the form its file input belongs to.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64=; the staging route answers each request with metadata naming the file that
 * request carried, so the reader can tell whose upload filled which form.
 *
 * RED-FIRST, measured 2026-10-02 on the committed dist of develop `761631fb4`: both inputs named
 * `doc` got the virtual form `gina-upload-doc`, form B's upload filled form A's hidden fields
 * (`b.png`) and form B received none; the control passed. Green after the rebuild.
 *
 *   01 CONTROL different input names: each form gets its own file's metadata
 *   02 the same name in both forms: each form still gets its own file's metadata
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-same-name-b732.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

/** One form holding one staged file input named `name` (ids derived from `key`). */
function form(id, key, name) {
    return '<form id="' + id + '" data-gina-form-rule="' + id + '" action="/upload-save" method="post">'
        + '<input id="title' + key + '" type="text" name="title" value="' + key + '">'
        + '<input id="doc' + key + '" type="file" name="' + name + '" data-gina-form-upload-action="/upload-stage"'
        + ' data-gina-form-upload-preview="doc' + key + '-preview" data-gina-form-upload-error="doc' + key + '-error">'
        + '<ul id="doc' + key + '-preview"></ul><p id="doc' + key + '-error" hidden></p>'
        + '<button id="' + id + '-submit" type="submit">Save ' + key + '</button></form>';
}

function page(nameA, nameB) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>two forms, one name</title>'
        + '<link rel="icon" href="data:,">'
        + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>'
        + form('b459form', 'A', nameA) + form('b459declared', 'B', nameB)
        + '</body></html>';
}

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

async function boot(pw, nameA, nameB) {
    const sink = { errors: [], staged: [] };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    await pw.route('**/upload-stage', (route) => {
        const name = stagedName(route.request());
        sink.staged.push(name);
        return route.fulfill(echo(name));
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(page(nameA, nameB), 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms['b459form'] && window.gina.validator.$forms['b459declared']), null, { timeout: 15000 });
    return sink;
}

/** The metadata a form's hidden fields hold for its first staged file (null when the field is absent). */
function meta(pw, formId, prefix) {
    return pw.evaluate(([id, p]) => {
        const f = document.getElementById(id);
        const v = (k) => { const el = f.querySelector('input[name="' + p + '[0][' + k + ']"]'); return el ? el.value : null; };
        return { originalFilename: v('originalFilename'), location: v('location') };
    }, [formId, prefix]);
}

/** Wait until a form's metadata names `file`; false on timeout, never a throw. */
function filled(pw, formId, prefix, file) {
    return pw.waitForFunction(([id, p, n]) => {
        const el = document.getElementById(id).querySelector('input[name="' + p + '[0][originalFilename]"]');
        return !!(el && el.value === n);
    }, [formId, prefix, file], { timeout: 5000 }).then(() => true).catch(() => false);
}

const stage = (pw, sel, file) => pw.setInputFiles(sel, { name: file, mimeType: 'image/png', buffer: PNG });

async function run(pw, nameA, nameB) {
    const sink = await boot(pw, nameA, nameB);
    await stage(pw, '#docA', 'a.png');
    await filled(pw, 'b459form', nameA, 'a.png');
    await stage(pw, '#docB', 'b.png');
    await filled(pw, 'b459declared', nameB, 'b.png');
    await pw.waitForTimeout(400);
    return {
        staged: sink.staged.slice(),
        A: await meta(pw, 'b459form', nameA),
        B: await meta(pw, 'b459declared', nameB),
        errors: sink.errors.slice()
    };
}

const OWN = { staged: ['a.png', 'b.png'],
    A: { originalFilename: 'a.png', location: '/tmp/uploads/a.png' },
    B: { originalFilename: 'b.png', location: '/tmp/uploads/b.png' },
    errors: [] };

test.describe('#B732 — same-named staged inputs in two forms fill their own form', () => {

    test('01 CONTROL different names: each form gets its own file\'s metadata', async ({ page: pw }) => {
        expect(await run(pw, 'doca', 'docb')).toEqual(OWN);
    });

    test('02 the same name in both forms: each form still gets its own file\'s metadata', async ({ page: pw }) => {
        const seen = await run(pw, 'doc', 'doc');
        const virtual = await pw.evaluate(() => [document.getElementById('docA').getAttribute('data-gina-form-virtual'),
            document.getElementById('docB').getAttribute('data-gina-form-virtual')]);
        expect(seen, 'virtual forms: ' + JSON.stringify(virtual)).toEqual(OWN);
    });
});
