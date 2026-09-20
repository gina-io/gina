'use strict';

/**
 * Playwright RUNTIME e2e for gh#76 + #B571 — a form's (or a link's) `text/html` XHR answer is
 * routed by the popin the SUBMITTING element lives in, never by "the active popin".
 *
 * THE DEFECTS (all measured on the real bundle before the fix — the numbers are the arms):
 *  - a PAGE form's HTML answer arriving while a popin was OPEN replaced that popin's content
 *    and the form's declared success callback never ran (§02);
 *  - arriving while a popin was LOADING (its `activePopinId` set, `isOpen` false — reachable
 *    through a preload-opted-out trigger, NOT a hovered default one) it raised a FALSE 422
 *    error callback, `Popin x is not open !`, after a successful server write (§03);
 *  - a form INSIDE a popin had its content replaced but its declared success callback was
 *    never called either — the popin branch returned before the `.hform` companion (#B571,
 *    §05) — and the same early return skipped a link's `.hlink` companion (§12a);
 *  - with TWO popins open the answer landed in whichever open popin was registered first
 *    (§11);
 *  - the request-side half: a page form submitted while a popin was open told the server it
 *    came from that popin (`X-Gina-Popin-*` headers), so the server answered a popin redirect
 *    (§08), and a plain `location` XHR redirect from a page form was loaded INTO the open
 *    popin instead of navigating the page (§09).
 *
 * THE FIX (slice 1): the popin is captured at submit by containment
 * (`gina.popin.getPopinContaining($form)`) into the per-send closure, and read at settle only
 * while still open and still containing the form; `getActivePopin()` returns OPEN popins only;
 * `popinLoadContent` loads into the popin it is called on; the popin branch emits the
 * `.hform` / `.hlink` companions; the redirect branch follows the same rule.
 *
 * Harness: the committed runtime server serves the REAL built bundle and the `hformform` rule
 * whisper (`/js/gina.onload.hform.js`); the scene page, the fragments and every endpoint are
 * `page.route`'d, so nothing in the repo is touched. Answers are HELD for a controlled time,
 * which is what makes "popin open / loading at settle" deterministic rather than raced.
 *
 * Red-first (pre-fix dist): §02, §03, §05, §08, §09, §11, §12a, §12b FAIL for the reasons
 * above; §01, §04, §06, §07, §10 are controls that pass on both sides of the fix.
 *
 * Trigger facts that shape the scenes (measured): a legacy trigger's authored id is rewritten
 * at registration — select it by `[data-gina-popin-name]`; a hovered default trigger ADOPTS
 * its preload, so `popinLoad` (and its early `setActivePopinId`) never runs — the loading
 * window needs `data-gina-dialog-preload="false"`; a legacy trigger injected into loaded
 * content is inert — a popin opened from inside another uses the declarative shape.
 *
 * Run:
 *   npx playwright test test/e2e/validator-popin-form-target.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// Every callback records what it received; `kind` tells the two payload shapes apart —
// the legacy `{contentType, content, status}` (raw HTML) vs the parsed xhr-data object.
const RECORDER = 'window.__x76={success:[],error:[],link:[]};'
    + 'function _d(e,d){return (d&&typeof d===\'object\')?d:(e&&e.detail)||null;}'
    + 'function _rec(d){return {kind:(d&&d.content)?\'html\':(d&&typeof d),keys:d?Object.keys(d).slice(0,8):null,status:d&&d.status,error:d&&d.error};}'
    + 'window.onRowSaved=function(e,d){window.__x76.success.push(_rec(_d(e,d)));};'
    + 'window.onRowError=function(e,d){window.__x76.error.push(_rec(_d(e,d)));};'
    + 'window.onLinkOk=function(e,d){window.__x76.link.push(_rec(_d(e,d)));};';

const FORM = '<form id="hformform" data-gina-form-rule="hformform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" action="/x76/save" method="post">'
    + '<label>Reference <input id="hform-input" type="text" name="ref" value="abc"></label>'
    + '<button id="hformform-submit" type="submit">Save</button></form>';

const TRIGGERS = {
    // default preload: hover warms, the click adopts the in-flight GET (#B54)
    'legacy':        '<button data-gina-popin-name="x76" data-gina-popin-url="/frag/x76.html">Open</button>',
    // opted out: the click runs popinLoad, which sets activePopinId BEFORE the content lands
    'legacy-optout': '<button data-gina-popin-name="x76" data-gina-popin-url="/frag/x76.html" data-gina-dialog-preload="false">Open</button>',
    // declarative, default MODELESS — the non-modal shims still inert everything outside the
    // popin and lock scroll (measured), so page elements are clicked BY SCRIPT in these arms
    'dialog':        '<button id="trig-dialog" data-gina-dialog="x76" data-gina-dialog-src="/frag/x76.html" data-gina-dialog-preload="false">Open</button>',
    'none':          ''
};

function buildPage(o) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>x76</title>'
        + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.hform.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + RECORDER + '</script></head><body><h1>x76</h1>'
        + TRIGGERS[o.trigger || 'legacy']
        + '<ul><li id="row-42">before</li></ul>'
        + (o.noPageForm ? '' : FORM)
        + (o.extra || '')
        + '</body></html>';
}

// The answer a `renderWithoutLayout` action produces: a fragment + the two hidden inputs.
const XHR_INPUTS = '<input type="hidden" id="gina-without-layout-xhr-data" value="%7B%22ok%22%3Atrue%7D">'
    + '<input type="hidden" id="gina-without-layout-xhr-view" value="%7B%7D">';
const FORM_ANSWER_HTML = '<li id="row-42">saved</li>' + XHR_INPUTS;
const FRAG = '<div id="x76-frag">popin content</div>';
// A popin whose content carries a rule-bound form (§05 / §07 / §11).
const FRAG_WITH_FORM = '<div id="x76-frag"><p>popin content</p>'
    + '<form id="pform" data-gina-form-rule="pform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" action="/x76/save" method="post">'
    + '<input name="ref" value="in-popin"><button id="pform-submit" type="submit">Save</button></form></div>';

const ANSWERS = {
    'html':     { contentType: 'text/html; charset=utf-8',        body: FORM_ANSWER_HTML },
    'json':     { contentType: 'application/json; charset=utf-8', body: '{"ok":true,"via":"json"}' },
    'redirect': { contentType: 'application/json; charset=utf-8', body: '{"isXhrRedirect":true,"location":"/landing"}' },
    'close':    { contentType: 'application/json; charset=utf-8', body: '{"isXhrRedirect":true,"popin":{"close":true}}' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Route the scene: the page, the popin fragment (held `o.popinDelay` ms), the form answer
 * (held `o.formDelay` ms, shape `o.answer`), and `/landing`. Returns the request log,
 * the `X-Gina-Popin-*` headers seen on every form request, and the /landing hit count.
 */
async function routeScene(page, o) {
    const log = [], headers = [], t0 = Date.now(); let landingHits = 0;
    await page.route('**/x76', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: buildPage(o) }));
    await page.route('**/frag/x76.html', async (r) => {
        log.push('frag-req@' + (Date.now() - t0));
        await sleep(o.popinDelay || 0);
        log.push('frag-answer@' + (Date.now() - t0));
        await r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.frag || FRAG });
    });
    await page.route('**/x76/save', async (r) => {
        const h = r.request().headers();
        headers.push({ id: h['x-gina-popin-id'] || null, name: h['x-gina-popin-name'] || null });
        log.push('form-req@' + (Date.now() - t0));
        await sleep(o.formDelay || 0);
        log.push('form-answer@' + (Date.now() - t0));
        await r.fulfill(Object.assign({ status: 200 }, ANSWERS[o.answer || 'html']));
    });
    await page.route('**/landing', (r) => { landingHits++; r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html><body><h1 id="landing">landed</h1></body></html>' }); });
    return { log, headers, t0, hits: () => landingHits };
}

async function gotoAndBoot(page, needValidatorForm) {
    await page.goto(BASE + '/x76');
    await page.waitForFunction((need) => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.hasPopinHandler === true && window.gina.validator
        && (!need || (window.gina.validator.$forms && window.gina.validator.$forms['hformform']))),
        needValidatorForm, { timeout: 15000 });
}

/** Register popins in order; every one gets the validator so loaded forms are bound. */
async function registerPopins(page, names, preOpen) {
    const reg = await page.evaluate((a) => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            var v = window.gina.validator;
            var mk = function (n) { return new Promise(function (r) { new Popin({ name: n, preOpen: a.preOpen, validator: v }).on('ready', function () { r(n); }); }); };
            a.names.reduce(function (p, n) { return p.then(function () { return mk(n); }); }, Promise.resolve())
                .then(function () { resolve('READY'); });
        });
    }), { names: names, preOpen: !!preOpen });
    expect(reg, 'popins ' + names.join(',') + ' must register').toBe('READY');
}

async function activateLinks(page) {
    const ok = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 6000);
        var LinkHandler = window.require('gina/link');
        new LinkHandler({}).on('ready', function () { resolve('READY'); });
    }));
    expect(ok, 'the link plugin must activate').toBe('READY');
}

/**
 * A page element cannot be clicked by a POINTER while any popin is open: the non-modal shims
 * inert everything outside the popin and lock scroll (measured — Playwright reports
 * `<body data-gina-popin-scroll-lock="true"> intercepts pointer events`, the anchor carries
 * `inert`). A script can still dispatch the click — the autosave / timer shape — which is how
 * a page form's request is made while a popin is open, and what the request-side arms use.
 */
async function clickByScript(page, selector) {
    await page.evaluate((sel) => { document.querySelector(sel).click(); }, selector);
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

/** Everything an arm asserts on, read in one round trip. */
async function readState(page) {
    return await page.evaluate(() => {
        var gp = window.gina.popin, popins = {};
        for (var id in gp.$popins) {
            var el = document.getElementById(id), p = gp.$popins[id];
            popins[p.name] = { isOpen: !!p.isOpen, hasSaved: !!(el && /saved/.test(el.innerHTML)), hasFrag: !!(el && /popin content|content<\/p>/.test(el.innerHTML)), hasForm: !!(el && el.querySelector('#pform')) };
        }
        var active = gp.getActivePopin();
        return {
            calls: window.__x76,
            popins: popins,
            active: active ? { name: active.name, isOpen: !!active.isOpen } : null,
            activeId: gp.activePopinId,
            row: (document.getElementById('row-42') || {}).textContent || null,
            url: location.pathname
        };
    });
}

/** Submit the page form, then (optionally) open the popin `clickAfter` ms later, then settle. */
async function submitThenTrigger(page, o) {
    const formReq = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
    await page.click('#hformform-submit');
    await formReq;
    if (o.triggerSelector) {
        await sleep(o.clickAfter || 300);
        await page.click(o.triggerSelector);
    }
    await sleep(Math.max(o.formDelay || 0, o.popinDelay || 0) + 1200);
}

test.describe('gh#76 / #B571 — a form answer is routed by the popin the FORM is in', () => {

    test('§01 CONTROL — page form, no popin: raw HTML to the declared handler on both sides', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'none', formDelay: 300, answer: 'html' };
        await routeScene(page, o); await gotoAndBoot(page, true);
        await submitThenTrigger(page, o);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.calls.success.length, 'declared success ran once').toBe(1);
        expect(s.calls.success[0].kind, 'legacy payload: raw HTML').toBe('html');
        expect(s.row, 'nothing is inserted anywhere').toBe('before');
    });

    test('§02 page form, popin OPEN at settle: answer stays with the form, popin intact (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy', formDelay: 2000, popinDelay: 500, answer: 'html' };
        await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], true);
        await submitThenTrigger(page, Object.assign({ triggerSelector: '[data-gina-popin-name="x76"]' }, o));
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.popins.x76.isOpen, 'the popin is open at settle (scene premise)').toBe(true);
        expect(s.calls.error, 'no error callback').toEqual([]);
        expect(s.popins.x76.hasSaved, 'the popin content was NOT replaced by the form answer').toBe(false);
        expect(s.popins.x76.hasFrag, 'the popin still shows its own content').toBe(true);
        expect(s.calls.success.length, 'the declared success callback ran').toBe(1);
        expect(s.calls.success[0].kind, 'with the legacy raw-HTML payload').toBe('html');
    });

    test('§03 page form, popin LOADING at settle (opted-out trigger): no false 422 (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy-optout', formDelay: 2000, popinDelay: 3500, answer: 'html' };
        await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], true);
        await submitThenTrigger(page, Object.assign({ triggerSelector: '[data-gina-popin-name="x76"]' }, o));
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error, 'no false 422 `Popin x76 is not open !`').toEqual([]);
        expect(s.calls.success.length, 'the declared success callback ran').toBe(1);
        expect(s.calls.success[0].kind).toBe('html');
        // and the popin's own load completed normally afterwards
        expect(s.popins.x76.isOpen, 'the popin opened on its own once its content landed').toBe(true);
        expect(s.popins.x76.hasFrag).toBe(true);
    });

    test('§04 CONTROL — page form, hovered DEFAULT trigger still loading: legacy on both sides (the reported step 5 does not throw with a mouse)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy', formDelay: 2000, popinDelay: 3500, answer: 'html' };
        await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], true);
        await submitThenTrigger(page, Object.assign({ triggerSelector: '[data-gina-popin-name="x76"]' }, o));
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.calls.success.length).toBe(1);
        expect(s.calls.success[0].kind).toBe('html');
    });

    test('§05 form INSIDE the popin (positive control): content replaced AND the declared callback runs with xhr-data (RED pre-fix, #B571)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy-optout', noPageForm: true, frag: FRAG_WITH_FORM, formDelay: 800, popinDelay: 200, answer: 'html' };
        const rt = await routeScene(page, o); await gotoAndBoot(page, false); await registerPopins(page, ['x76'], true);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(document.getElementById('pform') && window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        await sleep(200);
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req;
        await sleep(o.formDelay + 1200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.popins.x76.hasSaved, 'the popin content WAS replaced by the answer (unchanged behaviour)').toBe(true);
        expect(rt.headers[0].name, 'a contained form DOES send the popin headers (control for §08)').toBe('x76');
        expect(s.calls.success.length, '#B571 — the declared success callback now runs for a form answering into a popin').toBe(1);
        expect(s.calls.success[0].kind, 'with the parsed xhr-data, not raw HTML').toBe('object');
        expect(s.calls.success[0].keys, 'the xhr-data payload').toEqual(['ok']);
    });

    test('§06 CONTROL — page form with a JSON answer while a popin is open: untouched on both sides', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy', formDelay: 2000, popinDelay: 500, answer: 'json' };
        await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], true);
        await submitThenTrigger(page, Object.assign({ triggerSelector: '[data-gina-popin-name="x76"]' }, o));
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.calls.success.length).toBe(1);
        expect(s.calls.success[0].keys, 'the parsed JSON (the validator appends `status`)').toEqual(['ok', 'via', 'status']);
        expect(s.popins.x76.hasFrag, 'the popin is untouched').toBe(true);
    });

    test('§07 CONTROL — form inside the popin, popin CLOSED in flight: legacy payload, no throw, stays closed', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy-optout', noPageForm: true, frag: FRAG_WITH_FORM, formDelay: 1500, popinDelay: 200, answer: 'html' };
        await routeScene(page, o); await gotoAndBoot(page, false); await registerPopins(page, ['x76'], true);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(document.getElementById('pform') && window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        await sleep(200);
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req;
        await sleep(300);
        await page.evaluate(() => { window.gina.popin.close('x76'); });
        await sleep(o.formDelay + 1200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.popins.x76.isOpen, 'the popin stays closed').toBe(false);
        expect(s.calls.success.length, 'the declared callback still runs').toBe(1);
        expect(s.calls.success[0].kind, 'with the legacy payload (no popin to load into)').toBe('html');
    });

    test('§08 headers: a page form submitted while a MODELESS popin is open sends NO X-Gina-Popin-* (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'dialog', formDelay: 300, popinDelay: 100, answer: 'html' };
        const rt = await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], false);
        await page.click('#trig-dialog');
        await page.waitForFunction(() => { var p = window.gina.popin.getPopinByName('x76'); return !!(p && p.isOpen && document.getElementById('x76-frag')); }, null, { timeout: 8000 });
        const formReq = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await clickByScript(page, '#hformform-submit'); await formReq;
        await sleep(o.formDelay + 1200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(rt.headers.length, 'one form request').toBe(1);
        expect(rt.headers[0], 'no popin context on the request — the form is not inside the popin').toEqual({ id: null, name: null });
        expect(s.popins.x76.hasFrag, 'and the answer did not land in the popin').toBe(true);
        expect(s.popins.x76.hasSaved).toBe(false);
    });

    test('§09 a plain `location` XHR redirect from a page form navigates the PAGE, not the open popin (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'dialog', formDelay: 300, popinDelay: 100, answer: 'redirect' };
        const rt = await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], false);
        await page.click('#trig-dialog');
        await page.waitForFunction(() => { var p = window.gina.popin.getPopinByName('x76'); return !!(p && p.isOpen && document.getElementById('x76-frag')); }, null, { timeout: 8000 });
        const formReq = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await clickByScript(page, '#hformform-submit'); await formReq;
        // MEASURED pre-fix: `$popin.load()` fetched /landing INTO the open popin (its close()
        // was a no-op — `isRedirecting` had just been set) AND the page redirect that follows
        // fetched it again, so /landing was hit TWICE and the page still navigated. Post-fix
        // the page navigates and nothing touches the popin: the hit count is the discriminator.
        await page.waitForURL('**/landing', { timeout: 4000 });
        expect(errors).toEqual([]);
        expect(rt.hits(), 'the redirect target was fetched exactly once, by the page (pre-fix: twice, once into the popin)').toBe(1);
        await expect(page.locator('#landing')).toHaveText('landed');
    });

    test('§10 CONTROL — a name-less `popin: {close}` answer with nothing open to close is a no-op, not a 422', async ({ page }) => {
        const errors = collectPageErrors(page);
        const o = { trigger: 'legacy-optout', formDelay: 2000, popinDelay: 3500, answer: 'close' };
        await routeScene(page, o); await gotoAndBoot(page, true); await registerPopins(page, ['x76'], true);
        await submitThenTrigger(page, Object.assign({ triggerSelector: '[data-gina-popin-name="x76"]' }, o));
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error, 'no `you need at list a popin.name` 422').toEqual([]);
        expect(s.calls.success.length).toBe(1);
        expect(s.popins.x76.isOpen, 'the loading popin still opened on its own').toBe(true);
    });

    test('§11 TWO popins open, the form\'s popin registered SECOND: the answer lands in the form\'s popin (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        // A carries the form and a declarative trigger for B (default modeless — #B574 fixed);
        // B is registered FIRST so the old first-open-in-registration-order rule picks B.
        const fragA = '<div id="x76-frag"><p>popin content</p>'
            + '<form id="pform" data-gina-form-rule="pform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" action="/x76/save" method="post">'
            + '<input name="ref" value="in-A"><button id="pform-submit" type="submit">Save</button></form>'
            + '<button id="open-b" data-gina-dialog="B" data-gina-dialog-src="/fragB" data-gina-dialog-preload="false">Open B</button></div>';
        const o = { trigger: 'legacy-optout', noPageForm: true, frag: fragA, formDelay: 2000, popinDelay: 200, answer: 'html' };
        await routeScene(page, o);
        await page.route('**/fragB', async (r) => { await sleep(400); await r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<div id="fragB"><p>B content</p></div>' }); });
        await gotoAndBoot(page, false); await registerPopins(page, ['B', 'x76'], true);
        await page.click('[data-gina-popin-name="x76"]');
        await page.waitForFunction(() => !!(document.getElementById('pform') && window.gina.validator.$forms && window.gina.validator.$forms['pform']), null, { timeout: 8000 });
        await sleep(200);
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req;
        await sleep(200); await page.click('#open-b');
        await page.waitForFunction(() => !!document.getElementById('fragB'), null, { timeout: 8000 });
        await sleep(o.formDelay + 1200);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.calls.error).toEqual([]);
        expect(s.popins.B.isOpen, 'B is open (scene premise)').toBe(true);
        expect(s.popins.x76.isOpen, 'A is open (scene premise)').toBe(true);
        expect(s.popins.B.hasSaved, 'the answer did NOT land in B').toBe(false);
        expect(s.popins.x76.hasSaved, 'the answer landed in A, the popin the form was in').toBe(true);
        expect(s.calls.success.length, 'and the declared callback ran (#B571)').toBe(1);
    });

    test('§12a a link INSIDE an in-page dialog: its declared success callback runs when the answer loads into that dialog (RED pre-fix, #B571)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const extra = '<dialog id="ipd"><p>in-page</p><a id="iplink" data-gina-link data-gina-link-event-on-success="onLinkOk" href="/x76/linkanswer">go</a></dialog>'
            + '<button id="open-ipd" data-gina-dialog="ipd">open ipd</button>';
        const o = { trigger: 'none', noPageForm: true, extra: extra };
        await routeScene(page, o);
        await page.route('**/x76/linkanswer', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p id="link-landed">saved</p>' + XHR_INPUTS }));
        await gotoAndBoot(page, false); await activateLinks(page); await registerPopins(page, ['boot-x76'], false);
        await page.click('#open-ipd');
        await page.waitForFunction(() => { var p = window.gina.popin.getPopinById('ipd'); return !!(p && p.isOpen); }, null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/linkanswer'), { timeout: 5000 });
        await page.click('#iplink'); await req;
        await sleep(1000);
        const s = await readState(page);
        const landed = await page.evaluate(() => !!(document.getElementById('ipd') && /saved/.test(document.getElementById('ipd').innerHTML)));
        expect(errors).toEqual([]);
        expect(landed, 'the answer loaded into the dialog the link is in (unchanged behaviour)').toBe(true);
        expect(s.calls.link.length, '#B571 — the declared link success callback now runs').toBe(1);
    });

    test('§12b a PAGE link clicked while a modeless popin is open: the answer stays with the link, popin intact (RED pre-fix)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const extra = '<a id="pagelink" data-gina-link data-gina-link-event-on-success="onLinkOk" href="/x76/linkanswer">page link</a>';
        const o = { trigger: 'dialog', noPageForm: true, extra: extra, popinDelay: 100 };
        await routeScene(page, o);
        await page.route('**/x76/linkanswer', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p id="link-landed">saved</p>' + XHR_INPUTS }));
        await gotoAndBoot(page, false); await activateLinks(page); await registerPopins(page, ['x76'], false);
        await page.click('#trig-dialog');
        await page.waitForFunction(() => { var p = window.gina.popin.getPopinByName('x76'); return !!(p && p.isOpen && document.getElementById('x76-frag')); }, null, { timeout: 8000 });
        const req = page.waitForRequest((r) => r.url().endsWith('/x76/linkanswer'), { timeout: 5000 });
        await clickByScript(page, '#pagelink'); await req;
        await sleep(1000);
        const s = await readState(page);
        expect(errors).toEqual([]);
        expect(s.popins.x76.hasSaved, 'the popin content was NOT replaced by the page link\'s answer').toBe(false);
        expect(s.popins.x76.hasFrag).toBe(true);
        expect(s.calls.link.length, 'the declared link success callback ran').toBe(1);
    });
});
