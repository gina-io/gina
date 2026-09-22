'use strict';

/**
 * Playwright RUNTIME e2e for the shared region-binding policy (#gh76 slice 2, C1) as
 * `gina/nav` applies it to a navigated fragment.
 *
 * THE CHANGE: nav used to rebind EVERY id-bearing form of a swapped fragment through
 * `validateFormById` — bypassing the #B549 opt-in gate the boot scan applies — so a bare
 * `<form id="…">` inside a fragment was bound and its submit silently became an XHR
 * (measured on the real bundle before the change: bound, `X-Requested-With: XMLHttpRequest`,
 * same document). It now binds the region through `bindRegion()` (utils/dom): forms only
 * when they opt in, scripts the document does not already carry re-created once.
 *
 * Harness: the committed runtime server serves the REAL built bundle, the `hformform` rule
 * whisper (so the validator boots) and — keyed on the `/nav…` Referer — the nav routing
 * table; the scene page and every fragment are `page.route`'d.
 *
 * Red-first (pre-C1 dist): §02 FAILS (the bare form is bound and posts over XHR); §01, §03
 * and §04's page-bundle half pass on both sides; §04's fragment-script half exercises the
 * helper's dedup (nav's own registry deduped the same way, so it is a parity arm).
 *
 * Run:
 *   npx playwright test test/e2e/nav-region-binding.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

// The committed nav shell, re-pointed at the hform whisper so gina.validator boots.
const SHELL = fs.readFileSync(path.join(__dirname, 'fixtures', 'nav.html'), 'utf8')
    .replace('/js/gina.onload.js', '/js/gina.onload.hform.js');

const HOME = '<div id="frag-home" data-gina-nav-title="home"><a id="to-bare" href="/nav/bare">to bare</a> <a id="to-one" href="/nav/one">to one</a></div>';
const ONE  = '<div id="frag-one" data-gina-nav-title="one"><a id="to-bare" href="/nav/bare">to bare</a></div>';
// A bare id-bearing form (no rule, no data-gina-form-*), an opted-in form, a script the
// document does not have, and a re-declaration of the page bundle.
const BARE = '<div id="frag-bare" data-gina-nav-title="bare">'
    + '<form id="plain" action="/x76/plainsave" method="post"><input name="ref" value="abc"><button id="plain-submit" type="submit">Go</button></form>'
    + '<form id="opted" data-gina-form-rule="hformform" action="/x76/optedsave" method="post"><input name="ref" value="abc"><button id="opted-submit" type="submit">Go</button></form>'
    + '<script src="/js/x76-frag.js"></script><script src="/js/gina.min.js"></script>'
    + '<a id="to-one-b" href="/nav/one">to one</a></div>';

function pageFor(region, extra) {
    return SHELL.split('{{ region }}').join(region).replace('<div id="spacer">', (extra || '') + '<div id="spacer">');
}

async function routeScene(page) {
    const hits = [];
    let fragScriptHits = 0;
    await page.route('**/nav/x76', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
        body: pageFor(HOME, '<form id="pagebare" action="/x76/pagebare" method="post"><input name="ref" value="abc"><button id="pagebare-submit" type="submit">Go</button></form>') }));
    for (const [url, frag] of [['**/nav/bare', BARE], ['**/nav/one', ONE]]) {
        await page.route(url, (r) => {
            const h = r.request().headers();
            if ((h['x-gina-navigate'] || '') === 'fragment') {
                return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Vary': 'X-Gina-Navigate' }, body: frag });
            }
            return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageFor(frag) });
        });
    }
    await page.route('**/js/x76-frag.js', (r) => { fragScriptHits++; r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__x76frag=(window.__x76frag||0)+1;' }); });
    for (const u of ['plainsave', 'optedsave', 'pagebare']) {
        await page.route('**/x76/' + u, (r) => {
            const q = r.request();
            hits.push({ url: u, nav: q.isNavigationRequest(), type: q.resourceType(), xrw: q.headers()['x-requested-with'] || null });
            r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true}' });
        });
    }
    return { hits, fragScriptHits: () => fragScriptHits };
}

async function gotoAndBoot(page) {
    await page.goto(BASE + '/nav/x76');
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.hasNavHandler === true && window.gina.validator), null, { timeout: 15000 });
}

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    return errors;
}

const readForms = (page) => page.evaluate(() => ({
    forms: Object.keys((window.gina.validator && window.gina.validator.$forms) || {}),
    plainBinded: !!(window.gina.validator.$forms.plain && window.gina.validator.$forms.plain.binded),
    optedBinded: !!(window.gina.validator.$forms.opted && window.gina.validator.$forms.opted.binded),
    instance: window.__pageInstance
}));

test.describe('nav region binding — the shared bindRegion policy (#gh76 slice 2, C1)', () => {

    test('§01 CONTROL — a bare id-bearing form on the initial page is not bound (the #B549 boot gate)', async ({ page }) => {
        const errors = collectPageErrors(page);
        await routeScene(page);
        await gotoAndBoot(page);
        const s = await readForms(page);
        expect(errors).toEqual([]);
        expect(s.forms, 'nothing bound at boot').toEqual([]);
    });

    test('§02 a bare id-bearing form inside a navigated fragment is NOT bound and submits natively (RED pre-C1: bound, XHR)', async ({ page }) => {
        const errors = collectPageErrors(page);
        const rt = await routeScene(page);
        await gotoAndBoot(page);
        await page.click('#to-bare');
        await page.waitForSelector('#frag-bare', { timeout: 8000 });
        await page.waitForTimeout(300);
        const s = await readForms(page);
        expect(s.forms, 'only the opted-in form is bound').toEqual(['opted']);
        expect(s.plainBinded).toBe(false);
        await page.click('#plain-submit');
        await page.waitForTimeout(1200);
        expect(errors).toEqual([]);
        const plain = rt.hits.filter((h) => h.url === 'plainsave');
        expect(plain.length, 'the form submitted').toBe(1);
        expect(plain[0].nav, 'a NATIVE document submit, not an XHR').toBe(true);
        expect(plain[0].xrw).toBe(null);
    });

    test('§03 CONTROL — an opted-in form in the same fragment is bound and submits over XHR', async ({ page }) => {
        const errors = collectPageErrors(page);
        const rt = await routeScene(page);
        await gotoAndBoot(page);
        await page.click('#to-bare');
        await page.waitForSelector('#frag-bare', { timeout: 8000 });
        await page.waitForTimeout(300);
        const s = await readForms(page);
        expect(s.optedBinded).toBe(true);
        await page.click('#opted-submit');
        await page.waitForTimeout(1200);
        expect(errors).toEqual([]);
        const opted = rt.hits.filter((h) => h.url === 'optedsave');
        expect(opted.length).toBe(1);
        expect(opted[0].nav, 'an XHR submit').toBe(false);
        expect(opted[0].xrw).toBe('XMLHttpRequest');
        const s2 = await readForms(page);
        expect(s2.instance, 'same document').toBe(s.instance);
    });

    test("§04 scripts: a fragment's new src is re-created in <head> once across two swaps; the page bundle it re-declares is never re-created", async ({ page }) => {
        const errors = collectPageErrors(page);
        const rt = await routeScene(page);
        await gotoAndBoot(page);
        const bundleBefore = await page.evaluate(() => document.querySelectorAll('script[src$="/js/gina.min.js"]').length);
        await page.click('#to-bare');
        await page.waitForSelector('#frag-bare', { timeout: 8000 });
        await page.waitForFunction(() => window.__x76frag === 1, null, { timeout: 5000 });
        const after1 = await page.evaluate(() => ({
            headFrag: document.head.querySelectorAll('script[src$="/js/x76-frag.js"]').length,
            bundleHead: document.head.querySelectorAll('script[src$="/js/gina.min.js"]').length,
            ran: window.__x76frag
        }));
        expect(after1.headFrag, 'one head copy of the fragment script').toBe(1);
        expect(after1.ran).toBe(1);
        expect(after1.bundleHead, 'the page bundle was not re-created').toBe(bundleBefore);
        // away and back: the src is now carried by the document (head), so not re-created
        await page.click('#to-one-b');
        await page.waitForSelector('#frag-one', { timeout: 8000 });
        await page.click('#to-bare');
        await page.waitForSelector('#frag-bare', { timeout: 8000 });
        await page.waitForTimeout(500);
        const after2 = await page.evaluate(() => ({
            headFrag: document.head.querySelectorAll('script[src$="/js/x76-frag.js"]').length,
            ran: window.__x76frag
        }));
        expect(errors).toEqual([]);
        expect(after2.headFrag, 'still one head copy').toBe(1);
        expect(after2.ran, 'executed once for the page lifetime').toBe(1);
        expect(rt.fragScriptHits(), 'fetched once').toBe(1);
    });
});
