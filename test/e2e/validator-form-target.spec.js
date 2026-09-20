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
const RECORDER = 'window.__x76={success:[],error:[],swap:[],lastSuccess:null};'
    + 'function _d(e,d){return (d&&typeof d===\'object\')?d:(e&&e.detail)||null;}'
    + 'function _rec(d){return {kind:(d&&d.content&&!(\'swapped\' in d))?\'html\':(d&&(\'swapped\' in d))?\'swap\':(d&&typeof d),keys:d?Object.keys(d).slice(0,10):null,status:d&&d.status,error:d&&d.error,reason:d&&d.reason,swapped:d&&d.swapped,swap:d&&d.swap,data:d&&d.data,targetId:d&&d.target&&d.target.id,overrides:d&&d.overrides};}'
    + 'window.onRowSaved=function(e,d){var x=_d(e,d);window.__x76.lastSuccess=x;window.__x76.success.push(_rec(x));};'
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
    'json':      { contentType: 'application/json; charset=utf-8', body: '{"ok":true,"via":"json"}' },
    'tr':        { contentType: 'text/html; charset=utf-8',        body: '<tr id="new-row"><td>cell</td></tr>' + XHR_INPUTS },
    // #gh76 slice 3 — out-of-band: elements addressed to the page by id, wherever the main answer goes
    'oob':        { contentType: 'text/html; charset=utf-8',       body: '<b>saved</b><div id="totals" data-gina-swap-oob="true">t-oob</div><div id="nowhere" data-gina-swap-oob="true">x</div>' + XHR_INPUTS },
    'oob-select': { contentType: 'text/html; charset=utf-8',       body: '<li id="row-42">sel-a</li><p id="noise">noise</p><div id="totals" data-gina-swap-oob="true">t-sel</div>' + XHR_INPUTS },
    'oob-only':   { contentType: 'text/html; charset=utf-8',       body: '<div id="totals" data-gina-swap-oob="true">t-only</div>' + XHR_INPUTS },
    'oob-popin':  { contentType: 'text/html; charset=utf-8',       body: '<b>saved</b><div id="totals" data-gina-swap-oob="true">t-popin</div>' + XHR_INPUTS },
    'oob-form':   { contentType: 'text/html; charset=utf-8',       body: form('data-gina-swap-oob="true"').replace('value="abc"', 'value="second"') + XHR_INPUTS },
    'oob-tr':     { contentType: 'text/html; charset=utf-8',       body: '<template><tr id="r0" data-gina-swap-oob="true"><td>oobcell</td></tr></template>' + XHR_INPUTS }
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
    // gh#76 §6 — `o.headers`: response headers the sink answers with (X-Gina-Retarget / -Reswap / -Reselect)
    await page.route('**/x76/save', async (r) => { log.saves++; await sleep(o.formDelay || 0); await r.fulfill(Object.assign({ status: 200 }, ANSWERS[o.answer || 'html'], ( o.headers ? { headers: o.headers } : {} ))); });
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

    test('§19 #B578 — a table-row answer swapped into a <tbody> lands as a ROW, not as its cell text (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#tb" data-gina-form-swap="beforeend"', answer: 'tr',
            extra: '<table><tbody id="tb"><tr id="r0"><td>first</td></tr></tbody></table>' });
        await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        const t = await page.evaluate(() => ({
            rows: document.querySelectorAll('#tb tr').length,
            newRow: !!document.getElementById('new-row'),
            // pre-fix the parse reduced the row to the text `cell`, which a <tbody> then foster-parents BEFORE the table
            strayText: /cell/.test((document.querySelector('table') || {}).previousSibling ? document.querySelector('table').previousSibling.textContent || '' : '')
        }));
        expect(errors).toEqual([]);
        expect(s.calls.success.length).toBe(1);
        expect(t.rows, 'two rows: the original and the appended one').toBe(2);
        expect(t.newRow, 'the appended row is a real <tr> with its id').toBe(true);
        expect(t.strayText, 'no cell text leaked outside the table').toBe(false);
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

    test('§20 out-of-band: the answer updates an element the form never targeted, the main swap gets the remainder, an unmatched id is refused without an error (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', answer: 'oob' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'the out-of-band element landed in the page').toBe('t-oob');
        expect(s.row, 'the main target got the answer WITHOUT the out-of-band elements').toBe('<b>saved</b>');
        expect(s.calls.success.length, 'one success, not one per element').toBe(1);
        expect(s.calls.error.length, 'an unmatched id is a dev notice, never an error').toBe(0);
        const p = await page.evaluate(() => {
            var d = window.__x76.lastSuccess;
            return { oob: d && d.oob, remainder: d && d.remainder, rawHasAttr: !!(d && /data-gina-swap-oob/.test(d.content || '')) };
        });
        expect(p.oob).toEqual([
            { id: 'totals',  strategy: 'outerHTML', swapped: true },
            { id: 'nowhere', strategy: 'outerHTML', swapped: false, reason: 'noTarget' }
        ]);
        expect(p.remainder).toBe('<b>saved</b>');
        expect(p.rawHasAttr, '`content` stays the raw answer — its meaning does not fork by path').toBe(true);
    });

    test('§21 out-of-band runs BEFORE `select`, so an element outside the selection still lands (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#list" data-gina-form-select="li"', answer: 'oob-select' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'the out-of-band element is not in the selection and lands anyway').toBe('t-sel');
        // §07's semantics, unchanged: every match is swapped whole, and the `<p id="noise">`
        // that sits between them in the answer is still dropped
        expect(s.list).toBe('<li id="row-42">sel-a</li>');
    });

    test('§22 out-of-band from a form INSIDE a popin updates the page behind it; an answer addressed only to the page leaves the dialog as it is (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM(''), answer: 'oob-only', formDelay: 400, popinDelay: 200 });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(1800);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'the page behind the dialog was updated').toBe('t-only');
        expect(s.popins.x76.isOpen, 'the dialog is still open').toBe(true);
        expect(s.popins.x76.hasFrag, 'and still holds its own content — an empty remainder never blanks it').toBe(true);
        expect(s.calls.error.length).toBe(0);
        expect(s.calls.success.length).toBe(1);
        const bound = await page.evaluate(() => Object.keys(window.gina.validator.$forms || {}));
        expect(bound, 'the dialog form is still bound').toContain('pform');
    });

    test('§23 out-of-band on the legacy path (no declared target): nothing is inserted, the elements still land, the payload reports them (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { answer: 'oob' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'htmx: out-of-band items are processed even with no main swap').toBe('t-oob');
        expect(s.row, 'nothing was inserted — there was no target').toBe('before');
        const p = await page.evaluate(() => {
            var d = window.__x76.lastSuccess;
            return { oobIds: (d && d.oob || []).map(function (x) { return x.id; }), remainder: d && d.remainder, rawHasAttr: !!(d && /data-gina-swap-oob/.test(d.content || '')) };
        });
        expect(p.oobIds).toEqual(['totals', 'nowhere']);
        expect(p.remainder, '`remainder` is what a handler should insert — `content` would land them twice').toBe('<b>saved</b>');
        expect(p.rawHasAttr).toBe(true);
    });

    test('§24 oobbeforeswap reaches a programmatic listener: it cancels with preventDefault() and rewrites detail.content — the on() wrapper exempts it (RED against the un-widened regex)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', answer: 'oob-popin' }); await gotoAndBoot(page, true);
        await page.evaluate(() => { window.gina.validator.$forms.hformform.on('oobbeforeswap', function (e) { window.__oobSeen = (window.__oobSeen || 0) + 1; e.preventDefault(); }); });
        await submitPage(page, { formDelay: 100 });
        let s = await readState(page);
        const seen = await page.evaluate(() => window.__oobSeen || 0);
        expect(errors).toEqual([]);
        expect(seen, 'the listener ran — a cancelled event still reaches it').toBe(1);
        expect(s.totals, 'preventDefault() skipped the swap').toBe('t0');
        expect(s.row, 'the main swap is unaffected').toBe('<b>saved</b>');
        await page.unroute('**/x76');
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', answer: 'oob-popin' }); await gotoAndBoot(page, true);
        await page.evaluate(() => { window.gina.validator.$forms.hformform.on('oobbeforeswap', function (e, d) { d.content = '<div id="totals">rewritten</div>'; }); });
        await submitPage(page, { formDelay: 100 });
        s = await readState(page);
        expect(s.totals, 'detail.content is rewritable, as on beforeswap').toBe('rewritten');
    });

    test('§25 an out-of-band swap that replaces the SUBMITTING form rebinds it after the events, so a second submit still works (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const log = await routeScene(page, { answer: 'oob-form' }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        let s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.success.length, 'the success events were delivered by the form that sent').toBe(1);
        expect(s.formsBound, 'the replacement carries the same id and is bound').toContain('hformform');
        const val = await page.evaluate(() => (document.getElementById('hform-input') || {}).value);
        expect(val, 'the page really holds the replacement').toBe('second');
        await submitPage(page, { formDelay: 100 });
        s = await readState(page);
        expect(log.saves, 'the rebound replacement sends too').toBe(2);
        expect(s.calls.success.length).toBe(2);
    });

    test('§26 an out-of-band table row wrapped in a <template> lands as a real row and leaves no wrapper behind (RED pre-C3)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM(''), answer: 'oob-tr', formDelay: 400, popinDelay: 200,
            extra: '<table><tbody id="tb"><tr id="r0"><td>first</td></tr></tbody></table>' });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(1800);
        const s = await readState(page);
        const t = await page.evaluate(() => ({
            rows: document.querySelectorAll('#tb tr').length,
            cell: (document.querySelector('#tb #r0 td') || {}).textContent || null,
            templates: document.querySelectorAll('template').length,
            popinHtml: (document.getElementById('x76') || {}).innerHTML || ''
        }));
        expect(errors).toEqual([]);
        expect(t.rows, 'still one row — it was REPLACED, not foster-parented into text').toBe(1);
        expect(t.cell).toBe('oobcell');
        expect(t.templates, 'the emptied wrapper was consumed with its element').toBe(0);
        expect(s.popins.x76.hasFrag, 'the dialog kept its own content').toBe(true);
    });
    // ── gh#76 §6 — the server's last word: X-Gina-Retarget / X-Gina-Reswap / X-Gina-Reselect ──
    // Read at settle, after the answer is known to be HTML, before the target fork and before
    // `beforeswap`. Red-first (pre-§6 dist): §27-§32, §34 and §35 FAIL (the headers are ignored:
    // nothing retargets, the legacy or declared path runs, no `overrides` reaches the handler);
    // §33 is the JSON control and passes on both sides.

    test('§27 X-Gina-Retarget creates a target where none was declared: the answer lands there, the payload is the swap shape and reports the override (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { headers: { 'X-Gina-Retarget': '#totals' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'the answer landed in the retargeted element').toBe('saved');
        expect(s.row, 'nothing else moved').toBe('before');
        expect(s.hiddenInPage).toBe(0);
        expect(s.calls.success.length).toBe(1); expect(s.calls.error.length).toBe(0);
        const p = s.calls.success[0];
        expect(p.kind).toBe('swap'); expect(p.swapped).toBe(true); expect(p.targetId).toBe('totals'); expect(p.swap).toBe('innerHTML');
        expect(p.overrides).toEqual({ retarget: { value: '#totals', applied: true } });
    });

    test('§28 X-Gina-Retarget wins over a DECLARED target (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', headers: { 'X-Gina-Retarget': '#totals' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals).toBe('saved');
        expect(s.row, 'the declared target is left alone').toBe('before');
        expect(s.calls.success[0].targetId).toBe('totals');
        expect(s.calls.success[0].overrides.retarget.applied).toBe(true);
    });

    test('§29 X-Gina-Reswap and X-Gina-Reselect replace the declared strategy and selection (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#list"', answer: 'li', headers: { 'X-Gina-Reswap': 'beforeend', 'X-Gina-Reselect': 'li' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.list, 'the two original rows are still there — appended, not replaced').toContain('<li id="row-42">before</li>');
        expect(s.list).toContain('sel-a'); expect(s.list).toContain('sel-b');
        expect(s.list, 'the selection dropped the noise').not.toContain('noise');
        const p = s.calls.success[0];
        expect(p.swap).toBe('beforeend');
        expect(p.overrides).toEqual({ reswap: { value: 'beforeend', applied: true }, reselect: { value: 'li', applied: true } });
    });

    test('§30 X-Gina-Retarget on a form INSIDE a popin: the page element is swapped, the popin content is intact (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { trigger: 'legacy', noPageForm: true, frag: FRAG_WITH_FORM(''), formDelay: 800, popinDelay: 200, headers: { 'X-Gina-Retarget': '#totals' } });
        await gotoAndBoot(page, false); await registerPopins(page, ['x76']);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req; await sleep(2200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals, 'retargeted onto the page').toBe('saved');
        expect(s.popins.x76.isOpen).toBe(true); expect(s.popins.x76.hasFrag, 'the dialog kept its content').toBe(true); expect(s.popins.x76.hasSaved).toBe(false);
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].targetId).toBe('totals');
    });

    test('§31 a Retarget that cannot be resolved: NO swap, success still fires with swapped:false and reason retargetError, no error callback (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', headers: { 'X-Gina-Retarget': '#nowhere' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row, 'the declared target is NOT written — the server meant somewhere else').toBe('before');
        expect(s.totals).toBe('t0');
        expect(s.calls.error.length, 'never a 422 for a server-side misconfiguration').toBe(0);
        expect(s.calls.success.length).toBe(1);
        const p = s.calls.success[0];
        expect(p.kind).toBe('swap'); expect(p.swapped).toBe(false); expect(p.reason).toBe('retargetError'); expect(p.targetId).toBe(null);
        expect(p.overrides.retarget.applied).toBe(false); expect(p.overrides.retarget.reason).toContain('no element matches');
        expect(s.isSending, 'the form is released').toBe(false);
    });

    test('§32 an unknown X-Gina-Reswap is ignored: the declared strategy applies, the report says why (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', headers: { 'X-Gina-Reswap': 'sideways' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row, 'innerHTML, the declared default').toBe('<b>saved</b>');
        const p = s.calls.success[0];
        expect(p.swapped).toBe(true); expect(p.swap).toBe('innerHTML');
        expect(p.overrides.reswap.applied).toBe(false); expect(p.overrides.reswap.reason).toContain('sideways');
    });

    test('§33 CONTROL — a JSON answer with X-Gina-Retarget is untouched: nothing swaps, the JSON payload is delivered (both sides)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { answer: 'json', headers: { 'X-Gina-Retarget': '#totals' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.totals).toBe('t0'); expect(s.row).toBe('before');
        expect(s.calls.success.length).toBe(1); expect(s.calls.success[0].keys).toEqual(['ok', 'via', 'status']);
        expect(s.calls.success[0].overrides).toBeUndefined();
    });

    test('§34 X-Gina-Reswap on a form with no target at all is ignored and reported as noTarget on the raw payload (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { headers: { 'X-Gina-Reswap': 'beforeend' } }); await gotoAndBoot(page, true);
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.row).toBe('before'); expect(s.totals).toBe('t0');
        const p = s.calls.success[0];
        expect(p.kind, 'the raw html payload, as without headers').toBe('html');
        expect(p.overrides).toEqual({ reswap: { value: 'beforeend', applied: false, reason: 'noTarget' } });
    });

    test('§35 beforeswap sees the override in its detail and keeps the last word (RED pre-§6)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page, { attrs: 'data-gina-form-target="#row-42"', headers: { 'X-Gina-Retarget': '#totals' } }); await gotoAndBoot(page, true);
        await page.evaluate(() => { window.gina.validator.$forms.hformform.on('beforeswap', function (e, d) { window.__ov = d.overrides || null; window.__ovTarget = d.target && d.target.id; d.content = '<u>listener</u>'; }); });
        await submitPage(page, { formDelay: 100 });
        const s = await readState(page);
        const seen = await page.evaluate(() => ({ ov: window.__ov, target: window.__ovTarget }));
        expect(errors).toEqual([]);
        expect(seen.target, 'the listener sees the FINAL target').toBe('totals');
        expect(seen.ov).toEqual({ retarget: { value: '#totals', applied: true } });
        expect(s.totals, 'the listener still rewrote what landed').toBe('listener');
        expect(s.row).toBe('before');
    });

});
