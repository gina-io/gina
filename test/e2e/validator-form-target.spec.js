'use strict';

/**
 * Playwright RUNTIME e2e for #gh76 slice 2 — `data-gina-form-target` / `-swap` / `-select`,
 * the `beforeswap` / `afterswap` events, the richer `text/html` payload, the fail-loud
 * refusal of a target that cannot be honoured, and the tolerant XHR-input parse (#B575).
 *
 * Harness: the slice-1 scene builder (the REAL built bundle + the `hformform` whisper from
 * the committed runtime server; page, fragments and endpoints `page.route`'d). The page form
 * takes the attributes each arm declares; the answers are held so the popin arms are
 * deterministic.
 *
 * Red-first (pre-C2 dist): §02, §03, §04, §05, §07-§16 and §18 FAIL (the attributes are
 * ignored: nothing swaps, the legacy payload is delivered, a bad target still sends; a popin
 * answer without the hidden inputs raises the false 422); §01, §06, §17 are controls that
 * pass on both sides.
 *
 * Run:
 *   npx playwright test test/e2e/validator-form-target.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// Declared callbacks record what they received; `kind` separates the payload shapes.
const RECORDER = 'window.__x76={success:[],error:[],swap:[]};'
    + 'function _d(e,d){return (d&&typeof d===\'object\')?d:(e&&e.detail)||null;}'
    + 'function _rec(d){return {kind:(d&&d.content&&!(\'swapped\' in d))?\'html\':(d&&(\'swapped\' in d))?\'swap\':(d&&typeof d),keys:d?Object.keys(d).slice(0,10):null,status:d&&d.status,error:d&&d.error,reason:d&&d.reason,swapped:d&&d.swapped,swap:d&&d.swap,data:d&&d.data,targetId:d&&d.target&&d.target.id};}'
    + 'window.onRowSaved=function(e,d){window.__x76.success.push(_rec(_d(e,d)));};'
    + 'window.onRowError=function(e,d){window.__x76.error.push(_rec(_d(e,d)));};'
    + 'window.onSwapped=function(e,d){var x=_d(e,d);window.__x76.swap.push({targetId:x&&x.target&&x.target.id,strategy:x&&x.strategy,innerBound:!!(window.gina.validator.$forms&&window.gina.validator.$forms.inner)});};';

function form(attrs) {
    return '<form id="hformform" data-gina-form-rule="hformform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" ' + (attrs || '') + ' action="/x76/save" method="post">'
        + '<label>Reference <input id="hform-input" type="text" name="ref" value="abc"></label>'
        + '<button id="hformform-submit" type="submit">Save</button></form>';
}
const TRIGGERS = {
    'legacy':        '<button data-gina-popin-name="x76" data-gina-popin-url="/frag/x76.html">Open</button>',
    'legacy-optout': '<button data-gina-popin-name="x76" data-gina-popin-url="/frag/x76.html" data-gina-dialog-preload="false">Open</button>',
    'none':          ''
};
function buildPage(o) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>x76</title>'
        + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.hform.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + RECORDER + '</script></head><body><h1>x76</h1>'
        + TRIGGERS[o.trigger || 'none']
        + '<ul id="list"><li id="row-42">before</li><li id="row-43">other</li></ul><div id="totals">t0</div>'
        + (o.noPageForm ? '' : form(o.attrs))
        + (o.extra || '')
        + '</body></html>';
}
const XHR_INPUTS = '<input type="hidden" id="gina-without-layout-xhr-data" value="%7B%22ok%22%3Atrue%7D">'
    + '<input type="hidden" id="gina-without-layout-xhr-view" value="%7B%7D">';
const ANSWERS = {
    'html':      { contentType: 'text/html; charset=utf-8',        body: '<b>saved</b>' + XHR_INPUTS },
    'html-bare': { contentType: 'text/html; charset=utf-8',        body: '<b>saved</b>' },
    'li':        { contentType: 'text/html; charset=utf-8',        body: '<li id="row-42">sel-a</li><p id="noise">noise</p><li id="row-99">sel-b</li>' + XHR_INPUTS },
    'form':      { contentType: 'text/html; charset=utf-8',        body: form('data-gina-form-target="this" data-gina-form-swap="outerHTML"').replace('value="abc"', 'value="second"') + XHR_INPUTS },
    'inner':     { contentType: 'text/html; charset=utf-8',        body: '<form id="inner" data-gina-form-rule="hformform" action="/x76/save2" method="post"><input name="ref" value="in"><button type="submit">i</button></form>' + XHR_INPUTS },
    'script':    { contentType: 'text/html; charset=utf-8',        body: '<i>s</i><script src="/js/x76-swap.js"></script>' + XHR_INPUTS },
    'json':      { contentType: 'application/json; charset=utf-8', body: '{"ok":true,"via":"json"}' }
};
const FRAG = '<div id="x76-frag">popin content</div>';
const FRAG_WITH_FORM = (attrs) => '<div id="x76-frag"><p>popin content</p>'
    + '<form id="pform" data-gina-form-rule="pform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" ' + (attrs || '') + ' action="/x76/save" method="post">'
    + '<input name="ref" value="in-popin"><button id="pform-submit" type="submit">Save</button></form></div>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function routeScene(page, o) {
    const log = { saves: 0, scriptHits: 0 };
    await page.route('**/x76', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: buildPage(o) }));
    await page.route('**/frag/x76.html', async (r) => { await sleep(o.popinDelay || 0); await r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.frag || FRAG }); });
    await page.route('**/x76/save', async (r) => { log.saves++; await sleep(o.formDelay || 0); await r.fulfill(Object.assign({ status: 200 }, ANSWERS[o.answer || 'html'])); });
    await page.route('**/x76/save2', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.route('**/js/x76-swap.js', (r) => { log.scriptHits++; r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__x76swap=(window.__x76swap||0)+1;' }); });
    return log;
}
async function gotoAndBoot(page, needValidatorForm) {
    await page.goto(BASE + '/x76');
    await page.waitForFunction((need) => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.hasPopinHandler === true && window.gina.validator
        && (!need || (window.gina.validator.$forms && window.gina.validator.$forms['hformform']))),
        needValidatorForm, { timeout: 15000 });
}
async function registerPopins(page, names, preOpen) {
    const reg = await page.evaluate((a) => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var v = window.gina.validator;
            var mk = function (n) { return new Promise(function (r) { new Popin({ name: n, preOpen: a.preOpen, validator: v }).on('ready', function () { r(n); }); }); };
            a.names.reduce(function (p, n) { return p.then(function () { return mk(n); }); }, Promise.resolve()).then(function () { resolve('READY'); });
        });
    }), { names: names, preOpen: !!preOpen });
    expect(reg, 'popins must register').toBe('READY');
}
function collectPageErrors(page) { const errors = []; page.on('pageerror', (e) => errors.push(String((e && e.message) || e))); return errors; }
async function clickByScript(page, selector) { await page.evaluate((sel) => { document.querySelector(sel).click(); }, selector); }
async function readState(page) {
    return await page.evaluate(() => {
        var gp = window.gina.popin, popins = {};
        for (var id in gp.$popins) {
            var el = document.getElementById(id), p = gp.$popins[id];
            popins[p.name] = { isOpen: !!p.isOpen, hasSaved: !!(el && /saved/.test(el.innerHTML)), hasFrag: !!(el && /popin content/.test(el.innerHTML)) };
        }
        var f = window.gina.validator.$forms.hformform;
        return {
            calls: window.__x76, popins: popins,
            row: (document.getElementById('row-42') || {}).innerHTML || null,
            list: (document.getElementById('list') || {}).innerHTML || null,
            totals: (document.getElementById('totals') || {}).textContent || null,
            hiddenInPage: document.querySelectorAll('#list input[type="hidden"], #totals input[type="hidden"]').length,
            isSending: !!(f && f.isSending),
            triggerLoading: (document.getElementById('hformform-submit') || {}).getAttribute ? document.getElementById('hformform-submit').getAttribute('data-gina-loading') : null,
            formsBound: Object.keys(window.gina.validator.$forms || {}),
            swapRan: window.__x76swap || 0,
            headSwapScripts: document.head.querySelectorAll('script[src$="/js/x76-swap.js"]').length
        };
    });
}
async function submitPage(page, o) {
    const formReq = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
    await page.click('#hformform-submit');
    await formReq;
    if (o && o.triggerSelector) { await sleep(o.clickAfter || 300); await page.click(o.triggerSelector); }
    await sleep(Math.max((o && o.formDelay) || 0, (o && o.popinDelay) || 0) + 1200);
}

test.describe('gh#76 slice 2 — a form answer swaps into the target the form declares', () => {

    test('§01 CONTROL — no attribute, no popin: raw HTML to the handler, nothing inserted', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, {}); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].kind).toBe('html');
        expect(s.row).toBe('before');
    });

    test('§02 data-gina-form-target="#row-42": the answer is swapped into the target (innerHTML), the hidden inputs stripped, the payload richer (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe('<b>saved</b>');
        expect(s.hiddenInPage, 'the hidden inputs never reach the page').toBe(0);
        expect(s.calls.success.length).toBe(1);
        const p = s.calls.success[0];
        expect(p.kind).toBe('swap'); expect(p.swapped).toBe(true); expect(p.swap).toBe('innerHTML'); expect(p.targetId).toBe('row-42');
        expect(p.data).toEqual({ ok: true });
        expect(p.keys).toEqual(['contentType', 'content', 'status', 'data', 'view', 'target', 'swap', 'swapped']);
    });

    test('§03 target + a popin OPEN at settle: the swap lands, the popin is intact (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', trigger: 'legacy', formDelay: 2000, popinDelay: 500 });
        await gotoAndBoot(page, true); await registerPopins(page, ['x76']);
        await submitPage(page, { triggerSelector: '[data-gina-popin-name="x76"]', formDelay: 2000, popinDelay: 500 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.popins.x76.isOpen).toBe(true); expect(s.popins.x76.hasFrag).toBe(true); expect(s.popins.x76.hasSaved).toBe(false);
        expect(s.row).toBe('<b>saved</b>'); expect(s.calls.success.length).toBe(1); expect(s.calls.error.length).toBe(0);
    });

    test('§04 target + a popin LOADING at settle (opted-out trigger): the swap lands, no false 422 (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', trigger: 'legacy-optout', formDelay: 2000, popinDelay: 3500 });
        await gotoAndBoot(page, true); await registerPopins(page, ['x76']);
        await submitPage(page, { triggerSelector: '[data-gina-popin-name="x76"]', formDelay: 2000, popinDelay: 3500 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe('<b>saved</b>'); expect(s.calls.success.length).toBe(1); expect(s.calls.error.length).toBe(0);
    });

    test('§05 a form INSIDE a popin with a target OUTSIDE it: the page target is swapped, the popin content is intact (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM('data-gina-form-target="#row-42"'), formDelay: 800, popinDelay: 200 });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(2200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe('<b>saved</b>');
        expect(s.popins.x76.hasFrag, 'the popin kept its content').toBe(true); expect(s.popins.x76.hasSaved).toBe(false);
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].kind).toBe('swap');
    });

    test('§06 CONTROL — a form inside a popin with NO target keeps the popin path: content replaced, xhr-data payload', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM(''), formDelay: 800, popinDelay: 200 });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(2200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.popins.x76.hasSaved).toBe(true); expect(s.row).toBe('before');
        // the parsed xhr-data VERBATIM — the slice-1 contract (`validator-popin-form-target.spec.js`
        // §05 pins it too). The non-dev half, where the transport inputs are absent and the payload
        // is `{status}` instead, is §18: together the two arms discriminate the branch's two shapes.
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].keys).toEqual(['ok']);
    });

    test('§07 data-gina-form-select="li": every match in document order is swapped, the noise is not (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#list" data-gina-form-select="li"', answer: 'li' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.list).toBe('<li id="row-42">sel-a</li><li id="row-99">sel-b</li>');
        expect(s.calls.success[0].swapped).toBe(true);
    });

    test('§08 a select that matches nothing: nothing swapped, swapped:false, success still delivered (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#list" data-gina-form-select=".absent"', answer: 'li' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe('before'); expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].swapped).toBe(false); expect(s.calls.error.length).toBe(0);
    });

    test('§09 the target left the document while the request was in flight: no swap, no throw, swapped:false (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', formDelay: 1500 }); await gotoAndBoot(page, true);
        const formReq = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#hformform-submit'); await formReq;
        await page.evaluate(() => { var r = document.getElementById('row-42'); r.parentNode.removeChild(r); });
        await sleep(2700);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe(null); expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].swapped).toBe(false); expect(s.calls.error.length).toBe(0);
    });

    test('§10 swap strategies: delete removes the target; beforeend appends (RED pre-C2)', async ({ page }) => {
        let errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42" data-gina-form-swap="delete"' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        let s = await readState(page);
        expect(errors).toEqual([]); expect(s.row).toBe(null); expect(s.calls.success[0].swap).toBe('delete');
        await page.unroute('**/x76');
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42" data-gina-form-swap="beforeend"' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        s = await readState(page);
        expect(s.row).toBe('before<b>saved</b>');
    });

    test('§11 outerHTML on `this`: the answer replaces the form, the replacement is bound and its declared callback runs on a SECOND submit (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const log = await routeScene(page, { attrs: 'data-gina-form-target="this" data-gina-form-swap="outerHTML"', answer: 'form' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        let s = await readState(page);
        expect(errors).toEqual([]);
        expect(await page.inputValue('#hform-input'), 'the replacement form is in the page').toBe('second');
        expect(s.calls.success.length).toBe(1); expect(s.formsBound).toEqual(['hformform']);
        await submitPage(page, { formDelay: 100 });
        s = await readState(page);
        expect(errors).toEqual([]);
        expect(log.saves, 'the replacement form submitted over XHR too').toBe(2);
        expect(s.calls.success.length, 'its declared callback ran').toBe(2);
    });

    test('§12 a target that resolves to nothing refuses the submit: no request, error callback {status:422, reason:targetError}, the trigger released (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const log = await routeScene(page, { attrs: 'data-gina-form-target="#nowhere"' }); await gotoAndBoot(page, true);
        await page.click('#hformform-submit'); await sleep(800);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(log.saves, 'nothing was sent').toBe(0);
        expect(s.calls.success.length).toBe(0); expect(s.calls.error.length).toBe(1);
        expect(s.calls.error[0].status).toBe(422); expect(s.calls.error[0].reason).toBe('targetError'); expect(s.calls.error[0].error).toMatch(/no element matches `#nowhere`/);
        expect(s.isSending).toBe(false); expect(s.triggerLoading).not.toBe('true');
    });

    test('§13 `next li` is reserved: refused with a message naming it; an unknown swap strategy is refused too (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        let log = await routeScene(page, { attrs: 'data-gina-form-target="next li"' }); await gotoAndBoot(page, true);
        await page.click('#hformform-submit'); await sleep(800);
        let s = await readState(page);
        expect(errors).toEqual([]); expect(log.saves).toBe(0); expect(s.calls.error[0].error).toMatch(/reserved/);
        await page.unroute('**/x76');
        log = await routeScene(page, { attrs: 'data-gina-form-target="#row-42" data-gina-form-swap="sideways"' }); await gotoAndBoot(page, true);
        await page.click('#hformform-submit'); await sleep(800);
        s = await readState(page);
        expect(log.saves).toBe(0); expect(s.calls.error[0].error).toMatch(/unknown swap strategy `sideways`/);
    });

    test('§14 beforeswap: a programmatic listener cancels with preventDefault(), or rewrites detail.content (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"' }); await gotoAndBoot(page, true);
        await page.evaluate(() => { window.gina.validator.$forms.hformform.on('beforeswap', function (e) { e.preventDefault(); }); });
        await submitPage(page, { formDelay: 100 });
        let s = await readState(page);
        expect(errors).toEqual([]); expect(s.row).toBe('before'); expect(s.calls.success[0].swapped).toBe(false);
        await page.unroute('**/x76');
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"' }); await gotoAndBoot(page, true);
        await page.evaluate(() => { window.gina.validator.$forms.hformform.on('beforeswap', function (e, d) { d.content = '<u>rewritten</u>'; }); });
        await submitPage(page, { formDelay: 100 });
        s = await readState(page);
        expect(s.row).toBe('<u>rewritten</u>'); expect(s.calls.success[0].swapped).toBe(true);
    });

    test('§15 data-gina-form-event-on-swap runs after the region is bound: a form the answer carried is already registered when the hook fires (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42" data-gina-form-event-on-swap="onSwapped"', answer: 'inner' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.swap).toEqual([{ targetId: 'row-42', strategy: 'innerHTML', innerBound: true }]);
        expect(s.formsBound.sort()).toEqual(['hformform', 'inner']);
        expect(s.calls.success.length, 'success follows afterswap').toBe(1);
    });

    test('§16 a `<script src>` in the answer is re-created once through the shared region policy (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const log = await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', answer: 'script' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        await page.waitForFunction(() => window.__x76swap === 1, null, { timeout: 5000 });
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.swapRan, 'executed once across two swaps').toBe(1); expect(s.headSwapScripts).toBe(1); expect(log.scriptHits).toBe(1);
    });

    test('§17 CONTROL — a JSON answer with a target declared: untouched, the JSON is the payload', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', answer: 'json' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]); expect(s.row).toBe('before');
        expect(s.calls.success[0].keys).toEqual(['ok', 'via', 'status']);
    });

    test('§18 #B575 — a popin answer WITHOUT the hidden inputs (outside dev mode) loads the popin and delivers an object, not a false 422 (RED pre-C2)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM(''), answer: 'html-bare', formDelay: 800, popinDelay: 200 });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(2200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error.length, 'no false 422').toBe(0);
        expect(s.popins.x76.hasSaved, 'the popin was loaded').toBe(true);
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].keys).toEqual(['status']);
    });
});
