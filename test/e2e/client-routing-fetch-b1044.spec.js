'use strict';

/**
 * Playwright RUNTIME e2e for the client routing fetch, fix #B1044 (the real built gina bundle, real
 * navigations).
 *
 * The browser fetches its routing table at boot. A navigation can cut that fetch while it runs: WebKit
 * rejects it when the navigation STARTS, and refuses any new fetch until the navigation ends; Chromium
 * rejects it when the page commits. A rejection then printed « routing dependency failed … degraded until
 * reload » on a page that was going away; and when the navigation did not replace the page (a 204, a
 * download) the page stayed with no table, for good. The fetch is now asked again three times, after
 * 300 ms, 1 s and 2.5 s: a page really left never reaches the end of that, and a page that stays gets its
 * table.
 *
 *   01 #B1044 — a link click cuts the fetch, the page is left: no message       (RED: the message)
 *   02 #B1044 — the same with a destination that takes 2.5 s: no message        (RED: the message)
 *   03 #B1044 — the navigation answers 204: the page gets its table, no message (RED on WebKit: no table)
 *   04 #B1044 — the navigation is a download: the same                          (RED on WebKit: no table)
 *   05 #B1044 — the navigation answers 204 after 2 s: the same                  (RED on WebKit: no table)
 *   06 #B1044 — a network failure that passes: the handlers see the table       (RED: no table, the message)
 *   07 #B1044 — a network failure that stays: four attempts, then one message,
 *      and the handlers are released with no table                              (RED: one attempt)
 * Controls, which pass on the pre-fix bundle too:
 *   08 a fetch that answers: one attempt, the handlers see the table, no message
 *   09 a 503: one attempt, the message at once    10 a body that is not JSON: the same
 *   11 the page-side log reads the message (it is what 01 and 02 read on a page already gone)
 *
 * The message is read from the page's own log, kept in sessionStorage across the navigation: while the
 * page goes away Playwright's console event can miss a call that did run (measured on Chromium).
 *
 * Scene: inline pages served by the runtime server (`/x76-page?b64=`) with the built onload
 * (/js/gina.onload.b884.js; its rules play no part); `page.route` holds or answers the routing fetch.
 *
 * Pre-fix arm: `GINA_B1044_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle to the page
 * instead of the working-tree dist (the RED arms fail there, the controls pass).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B1044_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1044_PREFIX_BUNDLE) : null;

// Same polling kicker as the other x76-page specs: runs onGinaLoaded once the framework is there.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// A `gina.ready` handler that records what it saw.
const READY = '(function(){var t=0;function r(){if(window.gina&&typeof window.gina.ready===\'function\'){'
    + 'window.gina.ready(function(){window.__ready={at:performance.now(),'
    + 'keys:Object.keys((window.gina.config&&window.gina.config.routing)||{}).length};});}'
    + 'else if(t++<200){setTimeout(r,10);}}r();}());';

const ROUTING = '**/_gina/assets/routing.json*';
const TABLE = JSON.stringify({ sentinel: { url: '/sentinel' } });
const MESSAGE = 'routing dependency failed';

const DEST_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>dest</title>'
    + '<link rel="icon" href="data:,"></head><body>dest</body></html>';
const DEST = 'x76-page?b64=' + Buffer.from(DEST_HTML).toString('base64url');

// Keeps, for this tab, what the first page did: each routing fetch and each console.error.
const PROBE = `(function(){
    if (document.title === 'dest' || location.search.indexOf(${JSON.stringify(Buffer.from(DEST_HTML).toString('base64url'))}) > -1) { return; }
    var log = { fetches: 0, errors: [] };
    function keep() { try { sessionStorage.setItem('b1044', JSON.stringify(log)); } catch (e) {} }
    var consoleError = console.error;
    console.error = function () { log.errors.push(String(arguments[0])); keep(); return consoleError.apply(console, arguments); };
    var nativeFetch = window.fetch;
    window.fetch = function (url) { if (String(url).indexOf('routing.json') > -1) { log.fetches++; keep(); } return nativeFetch.apply(this, arguments); };
}());`;

/**
 * Opens the first page.
 *
 * @param {object} page
 * @returns {Promise<void>}
 */
async function open(page) {
    let hits = null;
    if (PREFIX_BUNDLE) {
        hits = { n: 0 };
        await page.route('**/js/gina.min.js', (r) => { hits.n++; r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    await page.addInitScript(PROBE);
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>first</title><link rel="icon" href="data:,">'
        + '<script src="/js/gina.onload.b884.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + READY + '</script></head><body><a id="go" href="' + DEST + '">go</a></body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html).toString('base64url'));
    if (hits) { expect(hits.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
}

/** Answers the routing fetch with the table, the first request after `firstHeldMs`. */
async function answerRouting(page, firstHeldMs) {
    let n = 0;
    await page.route(ROUTING, async (r) => {
        n++;
        if (n === 1 && firstHeldMs) { await new Promise((x) => setTimeout(x, firstHeldMs)); }
        await r.fulfill({ status: 200, contentType: 'application/json', body: TABLE }).catch(() => {});
    });
}

/** Clicks the link while the routing fetch is in flight. */
async function clickWhileFetching(page) {
    await page.waitForTimeout(400);
    await page.locator('#go').click({ noWaitAfter: true });
}

/** What the first page logged. */
function pageLog(page) {
    return page.evaluate(() => JSON.parse(sessionStorage.getItem('b1044') || '{"fetches":0,"errors":[]}'));
}

/** The messages among a log's errors. */
function messages(log) {
    return log.errors.filter((e) => e.indexOf(MESSAGE) > -1);
}

/** The routing table's size on this page; null when there is none yet. */
function tableSize(page) {
    return page.evaluate(() => (window.gina && window.gina.config && window.gina.config.routing)
        ? Object.keys(window.gina.config.routing).length
        : null);
}

test.describe('#B1044 — a navigation that cuts the routing fetch', function () {

    test('01 #B1044 — a link click cuts the fetch, the page is left: no message', async ({ page }) => {
        await answerRouting(page, 4000);
        await open(page);
        await clickWhileFetching(page);
        await page.waitForFunction(() => document.title === 'dest', null, { timeout: 8000 });
        const log = await pageLog(page);
        expect(log.fetches, 'the first page did fetch').toBeGreaterThan(0);
        expect(messages(log), 'no failure reported on a page that went away').toEqual([]);
    });

    test('02 #B1044 — the same with a destination that takes 2.5 s: no message', async ({ page }) => {
        await answerRouting(page, 6000);
        await page.route('**/' + DEST, async (r) => {
            await new Promise((x) => setTimeout(x, 2500));
            await r.continue().catch(() => {});
        });
        await open(page);
        await clickWhileFetching(page);
        await page.waitForFunction(() => document.title === 'dest', null, { timeout: 8000 });
        const log = await pageLog(page);
        expect(log.fetches, 'the first page did fetch').toBeGreaterThan(0);
        expect(messages(log), 'no failure reported on a page that went away').toEqual([]);
    });

    test('03 #B1044 — the navigation answers 204: the page gets its table, no message', async ({ page }) => {
        test.setTimeout(30000);
        await answerRouting(page, 2500);
        await page.route('**/' + DEST, (r) => r.fulfill({ status: 204, body: '' }));
        await open(page);
        await clickWhileFetching(page);
        await expect.poll(() => tableSize(page), { message: 'the table reaches the page', timeout: 8000 }).toBe(1);
        expect(await page.evaluate(() => !!document.getElementById('go')), 'the page stayed').toBe(true);
        expect(messages(await pageLog(page))).toEqual([]);
    });

    test('04 #B1044 — the navigation is a download: the same', async ({ page }) => {
        test.setTimeout(30000);
        await answerRouting(page, 2500);
        await page.route('**/' + DEST, (r) => r.fulfill({
            status: 200,
            headers: { 'Content-Disposition': 'attachment; filename="a.txt"', 'Content-Type': 'text/plain' },
            body: 'x'
        }));
        await open(page);
        await clickWhileFetching(page);
        await expect.poll(() => tableSize(page), { message: 'the table reaches the page', timeout: 8000 }).toBe(1);
        expect(await page.evaluate(() => !!document.getElementById('go')), 'the page stayed').toBe(true);
        expect(messages(await pageLog(page))).toEqual([]);
    });

    test('05 #B1044 — the navigation answers 204 after 2 s: the same', async ({ page }) => {
        test.setTimeout(30000);
        await answerRouting(page, 3000);
        await page.route('**/' + DEST, async (r) => {
            await new Promise((x) => setTimeout(x, 2000));
            await r.fulfill({ status: 204, body: '' }).catch(() => {});
        });
        await open(page);
        await clickWhileFetching(page);
        await expect.poll(() => tableSize(page), { message: 'the table reaches the page', timeout: 10000 }).toBe(1);
        expect(await page.evaluate(() => !!document.getElementById('go')), 'the page stayed').toBe(true);
        expect(messages(await pageLog(page))).toEqual([]);
    });

    test('06 #B1044 — a network failure that passes: the handlers see the table', async ({ page }) => {
        let n = 0;
        await page.route(ROUTING, (r) => {
            n++;
            if (n === 1) { return r.abort('failed'); }
            return r.fulfill({ status: 200, contentType: 'application/json', body: TABLE });
        });
        await open(page);
        await expect.poll(() => page.evaluate(() => window.__ready || null), { message: 'the handlers ran', timeout: 8000 }).not.toBeNull();
        expect((await page.evaluate(() => window.__ready)).keys, 'the handlers saw the table').toBe(1);
        const log = await pageLog(page);
        expect(log.fetches, 'asked twice').toBe(2);
        expect(messages(log)).toEqual([]);
    });

    test('07 #B1044 — a network failure that stays: four attempts, then one message, the handlers released with no table', async ({ page }) => {
        test.setTimeout(30000);
        await page.route(ROUTING, (r) => r.abort('failed'));
        await open(page);
        await expect.poll(async () => messages(await pageLog(page)).length, { message: 'the failure is reported', timeout: 9000 }).toBe(1);
        const log = await pageLog(page);
        expect(log.fetches, 'the first attempt and three more').toBe(4);
        await expect.poll(() => page.evaluate(() => window.__ready || null), { message: 'the handlers are released', timeout: 3000 }).not.toBeNull();
        const ready = await page.evaluate(() => window.__ready);
        expect(ready.keys, 'with no table').toBe(0);
        expect(ready.at, 'by the 5 s fallback at the latest').toBeLessThan(6000);
    });

    test('08 CONTROL — a fetch that answers: one attempt, the handlers see the table, no message', async ({ page }) => {
        await answerRouting(page, 0);
        await open(page);
        await expect.poll(() => page.evaluate(() => window.__ready || null), { message: 'the handlers ran', timeout: 5000 }).not.toBeNull();
        expect((await page.evaluate(() => window.__ready)).keys).toBe(1);
        const log = await pageLog(page);
        expect(log.fetches).toBe(1);
        expect(messages(log)).toEqual([]);
    });

    test('09 CONTROL — a 503: one attempt, the message at once', async ({ page }) => {
        await page.route(ROUTING, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
        await open(page);
        await expect.poll(async () => messages(await pageLog(page)).length, { timeout: 2000 }).toBe(1);
        expect((await pageLog(page)).fetches, 'an answer from the server is not asked again').toBe(1);
    });

    test('10 CONTROL — a body that is not JSON: the same', async ({ page }) => {
        await page.route(ROUTING, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }));
        await open(page);
        await expect.poll(async () => messages(await pageLog(page)).length, { timeout: 2000 }).toBe(1);
        expect((await pageLog(page)).fetches).toBe(1);
    });

    test('11 CONTROL — the page-side log reads the message across a navigation', async ({ page }) => {
        await answerRouting(page, 0);
        await open(page);
        await page.evaluate(() => { console.error('[gina] ' + 'routing dependency failed' + ' — a control'); });
        await page.locator('#go').click();
        await page.waitForFunction(() => document.title === 'dest', null, { timeout: 8000 });
        expect(messages(await pageLog(page)).length, 'the instrument 01 and 02 read can fire').toBe(1);
    });
});
