'use strict';

/**
 * Playwright RUNTIME e2e for #B1015, #B1016 and #B1018 — links in popin content.
 *
 * #B1015: an `<a>` with no `href`, which the page gives a real `href` after gina has bound the content, did
 * nothing when clicked (the bind loop had typed it as an action, and register()'s listener cancelled every click
 * on it). It now follows the link rules: it loads into the popin, and one carrying a `target`, a `download`, a
 * `#` in its URL or a scheme other than http(s) is left to the browser. Its load carries no `?inheritedData`.
 * #B1016: a link carrying `download` was loaded into the popin by XHR; the browser now saves the file.
 * #B1018: a link whose URL has a scheme other than http(s) was fetched by XHR, which failed with an error; the
 * browser now handles it.
 *
 * Arms (the routes count requests by resource type, so a popin load reads `xhr`; « not prevented » is read by a
 * click listener added on the anchor after gina's own, which runs after them):
 *   01 a late href, clicked on the anchor: it loads into the popin by XHR, and the flag clears once it has loaded
 *   02 a late href, clicked on a child span: the same
 *   03 a late href with `download`: the browser downloads the file, nothing is loaded into the popin
 *   04 a late href with a `target`: the browser opens that window
 *   05 a late `tel:` href: the click is not prevented, and nothing is requested
 *   06 a link bound with its href and `download`: the browser downloads the file, nothing is requested by XHR
 *   07 a link bound with a `mailto:` href: the click is not prevented, nothing is requested, no error
 *   08 a partial swap: a late href written before the swap loads when clicked after it, and the popin then closes
 *   09 a popin registered with the validator: a `download` link in a form carrying inherited data is downloaded
 *      from its href as written, with no `?inheritedData`
 *   10 the same popin: a late href in that form loads, with no `?inheritedData`
 *   11 CONTROL a plain link loads into the popin by XHR
 *   12 CONTROL a late href, then `disabled`: nothing is requested, and no redirect starts
 *   13 CONTROL a link with its own id closes the popin
 *   14 CONTROL an in-page `#` link: the click is not prevented (the reading's negative control)
 *   15 CONTROL the validator popin: a plain link in that form loads with the inherited data in its query
 *
 * Subtract lever: B1015_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle URL
 * (page.route, zero disk mutation); `routeHits` counts the copies served, and each scene asserts at least one
 * whenever the lever is set.
 *
 * Run:
 *   npx playwright test test/e2e/popin-late-href-b1015.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

/** A page loading the built bundle; `onload` picks the onload script ('' or '.hform', whose forms whisper turns the validator on). */
const page_ = (title, onload, body) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<link rel="icon" href="data:,">'
    + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script src="/js/gina.onload' + onload + '.js"></script>'
    + '<script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script>'
    + '</head><body><h1>' + title + '</h1>' + body + '</body></html>';

const PAGE = page_('late popin links', '',
    '<button id="trig-d" type="button" data-gina-dialog="D" data-gina-dialog-src="/b1015/frag" data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open D</button>');
// the partial-swap scene: popin S re-loads #slot while open, which binds the whole dialog again
const PAGE_S = page_('late popin links (partial swap)', '',
    '<button id="trig-s" type="button" data-gina-dialog="S" data-gina-dialog-src="/b1015/fragS" data-gina-dialog-target="#slot"'
    + ' data-gina-dialog-modal="true" data-gina-dialog-preload="false">Open S</button> '
    + '<button id="trig-s2" type="button" data-gina-dialog="S" data-gina-dialog-src="/b1015/fragS2" data-gina-dialog-target="#slot"'
    + ' data-gina-dialog-modal="true" data-gina-dialog-preload="false">Swap S</button>');
// the validator scene: popin V is registered WITH the validator, the only way its forms are bound (and its link
// listener's inherited-data branch runs); its legacy trigger is selected by name, since its id is rewritten
const PAGE_V = page_('late popin links (validator)', '.hform',
    '<button type="button" data-gina-popin-name="V" data-gina-popin-url="/b1015/vfrag" data-gina-dialog-preload="false">Open V</button>');

const PAD = ' style="display:inline-block;padding:10px"';
const FRAG = '<div id="frag"><p id="frag-text">content</p>'
    + '<a class="late"' + PAD + '><span class="late-in">late href</span></a> '
    + '<a class="lateD"' + PAD + '><span>late href, download</span></a> '
    + '<a class="lateT"' + PAD + '><span>late href, target</span></a> '
    + '<a class="lateTel"' + PAD + '><span>late tel: href</span></a> '
    + '<a class="lateX"' + PAD + '><span>late href, then disabled</span></a> '
    + '<a class="bindD" href="/b1015/file" download' + PAD + '><span>download</span></a> '
    + '<a class="bindM" href="mailto:someone@example.com"' + PAD + '><span>mailto:</span></a> '
    + '<a class="plain" href="/b1015/plain"' + PAD + '><span>plain</span></a> '
    + '<a id="own-b1015" href="/b1015/own"' + PAD + '><span>own id</span></a> '
    + '<a class="hash" href="#frag-text"' + PAD + '><span>in-page</span></a> '
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_S = '<div id="fragS"><p>content</p>'
    + '<a class="slate"' + PAD + '><span>late href, outside the slot</span></a> '
    + '<div id="slot"><p id="slot1">slot v1</p></div>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const FRAG_S2 = '<div id="fragS"><div id="slot"><p id="slot2">slot v2</p></div></div>';
const VFRAG = '<div id="vfrag">'
    + '<form id="vform" data-gina-form-rule="vform" data-gina-form-inherits-data="%7B%22k%22%3A1%7D" action="/b1015/vsave" method="post">'
    + '<input type="text" name="q" value="x">'
    + '<a class="vdl" href="/b1015/file" download' + PAD + '><span>download</span></a> '
    + '<a class="vlate"' + PAD + '><span>late href</span></a> '
    + '<a class="vlink" href="/b1015/vnext"' + PAD + '><span>link</span></a></form>'
    + '<button class="gina-popin-close" type="button">Close</button></div>';
const LOADED = (id) => '<div id="' + id + '"><p>loaded into the popin</p></div>';
// what a file download answers: an archive header and an attachment disposition
const FILE = { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="b1015.zip"' },
    body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('b1015-archive')]) };
const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
const at = { position: { x: 2, y: 2 } };

/** Optional pre-fix subtract: serve an old bundle at the bundle URL. Returns the hit counter. */
async function maybeServePrefixBundle(page) {
    const hits = { n: 0 };
    if (process.env.B1015_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1015_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    return hits;
}

/**
 * Routes `/b1015/<name>` (any query) on `target` (the page, or its context for a popup's first request, which a
 * page route does not see), recording `<resource type> <path and query>` per request.
 */
async function record(target, reqs, name, resp, delay) {
    reqs[name] = [];
    await target.route(new RegExp('/b1015/' + name + '(\\?.*)?$'), (r) => {
        reqs[name].push(r.request().resourceType() + ' ' + r.request().url().replace(BASE, ''));
        if (!delay) return r.fulfill(resp);
        return new Promise((res) => setTimeout(() => res(r.fulfill(resp)), delay));
    });
}

async function waitForGina(page, withValidator) {
    await page.waitForFunction(
        (v) => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && (!v || window.gina.validator)),
        withValidator,
        { timeout: 15000 }
    );
}

/** Load the page and open popin D on its fragment. Returns the request counters. */
async function openScene(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = {};
    await page.route('**/b1015', (r) => r.fulfill(html(PAGE)));
    await page.route('**/b1015/frag', (r) => r.fulfill(html(FRAG)));
    // a slow answer for the late load, so the flag can be read while it is in flight
    await record(page, reqs, 'next', html(LOADED('nextBody')), 600);
    await record(page.context(), reqs, 'win', html(LOADED('winBody')));
    await record(page, reqs, 'file', FILE);
    await record(page, reqs, 'plain', html(LOADED('plainBody')));
    await record(page, reqs, 'own', html(LOADED('ownBody')));
    await page.goto(BASE + '/b1015');
    await waitForGina(page, false);
    if (process.env.B1015_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B1015_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.click('#trig-d');
    await page.waitForSelector('dialog[open] #frag', { timeout: 8000 });
    await page.waitForTimeout(200);
    return { routeHits, reqs };
}

/** Load the partial-swap page, open popin S, write a late href outside the slot, then swap the slot. */
async function openSceneS(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = { fragS2: 0 };
    await page.route('**/b1015s', (r) => r.fulfill(html(PAGE_S)));
    await page.route('**/b1015/fragS', (r) => r.fulfill(html(FRAG_S)));
    await page.route('**/b1015/fragS2', (r) => { reqs.fragS2++; return r.fulfill(html(FRAG_S2)); });
    await record(page, reqs, 'snext', html(LOADED('snextBody')));
    await page.goto(BASE + '/b1015s');
    await waitForGina(page, false);
    if (process.env.B1015_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B1015_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    await page.click('#trig-s');
    await page.waitForSelector('dialog[open] #fragS', { timeout: 8000 });
    await page.waitForTimeout(200);
    await setLate(page, '#fragS a.slate', { href: '/b1015/snext' });
    await page.evaluate(() => document.getElementById('trig-s2').click());
    await page.waitForSelector('dialog[open] #slot2', { timeout: 8000 });
    await page.waitForTimeout(400);
    expect(reqs.fragS2, 'the slot was swapped once').toBe(1);
    return { routeHits, reqs };
}

/** Load the validator page, register popin V with the validator, and open it. Returns the request counters. */
async function openSceneV(page) {
    const routeHits = await maybeServePrefixBundle(page);
    const reqs = {};
    await page.route('**/b1015v', (r) => r.fulfill(html(PAGE_V)));
    await page.route('**/b1015/vfrag', (r) => r.fulfill(html(VFRAG)));
    await record(page, reqs, 'vnext', html(LOADED('vnextBody')));
    await record(page, reqs, 'vlate', html(LOADED('vlateBody')));
    await record(page, reqs, 'file', FILE);
    await page.goto(BASE + '/b1015v');
    await waitForGina(page, true);
    if (process.env.B1015_PREFIX_BUNDLE) {
        expect(routeHits.n, 'B1015_PREFIX_BUNDLE was served at the bundle URL').toBeGreaterThan(0);
    }
    const reg = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 8000);
        window.require(['gina/popin'], function (Popin) {
            new Popin({ name: 'V', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
        });
    }));
    expect(reg, 'popin V must register').toBe('READY');
    await page.click('[data-gina-popin-name="V"]');
    await page.waitForSelector('dialog[open] #vfrag', { timeout: 8000 });
    await page.waitForTimeout(200);
    // scene control: the popin holds a bound form, so its link listener's inherited-data branch can run
    expect(await page.evaluate(() => window.gina.popin.getPopinByName('V').hasForm), 'popin V has a bound form').toBe(true);
    return { routeHits, reqs };
}

/** Writes attributes on an anchor of the open popin, as a page does after the content was bound. */
const setLate = (page, sel, attrs) => page.evaluate((a) => {
    var el = document.querySelector('dialog[open] ' + a.sel);
    Object.keys(a.attrs).forEach(function (k) { el.setAttribute(k, a.attrs[k]); });
}, { sel: sel, attrs: attrs });

/** Records the click's `defaultPrevented` on the anchor, after gina's own listeners on it have run. */
const watchPrevented = (page, sel) => page.evaluate((s) => {
    window.__b1015 = [];
    document.querySelector('dialog[open] ' + s).addEventListener('click', function (e) { window.__b1015.push(e.defaultPrevented); });
}, sel);
const prevented = (page) => page.evaluate(() => window.__b1015);

function readState(page, name) {
    return page.evaluate((n) => {
        var p = window.gina && window.gina.popin && window.gina.popin.getPopinByName(n);
        var el = p ? document.getElementById(p.id) : null;
        return {
            path: location.pathname + location.hash,
            isOpen: !!(p && p.isOpen === true),
            isRedirecting: !!(p && p.isRedirecting === true),
            loaded: el ? ['nextBody', 'winBody', 'plainBody', 'ownBody', 'snextBody', 'vnextBody', 'vlateBody']
                .filter(function (id) { return !!el.querySelector('#' + id); }) : null,
            fileText: el ? /b1015-archive/.test(el.textContent || '') : null
        };
    }, name);
}

/** Page errors, console errors, and the requests started for a URL that is not http(s). */
function watchPage(page) {
    const w = { errors: [], consoleErrors: [], otherSchemes: [] };
    page.on('pageerror', (e) => w.errors.push(String((e && e.message) || e)));
    page.on('console', (m) => { if (m.type() === 'error') w.consoleErrors.push(m.text().slice(0, 160)); });
    page.on('request', (q) => { if (!/^https?:/i.test(q.url())) w.otherSchemes.push(q.resourceType() + ' ' + q.url()); });
    return w;
}

const close = (page, name) => page.evaluate((n) => window.gina.popin.close(n), name);

test.describe('#B1015 #B1016 #B1018 links in popin content', () => {

    for (const [num, where, sel] of [['01', 'on the anchor', 'a.late'], ['02', 'on a child span', 'a.late span.late-in']]) {
        test(num + ' a late href, clicked ' + where + ': it loads into the popin by XHR, and the flag clears once it has loaded', async ({ page }) => {
            const w = watchPage(page);
            const { routeHits, reqs } = await openScene(page);
            await setLate(page, 'a.late', { href: '/b1015/next' });
            await page.click('dialog[open] #frag ' + sel, sel === 'a.late' ? at : undefined);
            await page.waitForTimeout(200);
            const inFlight = await readState(page, 'D');
            await page.waitForSelector('dialog[open] #nextBody', { timeout: 8000 });
            await page.waitForTimeout(200);
            const s = await readState(page, 'D');
            console.log('[B1015 ' + num + ']', 'in flight', JSON.stringify(inFlight), JSON.stringify(s), 'reqs', JSON.stringify(reqs.next), 'prefix-bundle hits', routeHits.n);
            expect(reqs.next).toEqual(['xhr /b1015/next']);
            expect(inFlight.isRedirecting, 'the popin waits for the load').toBe(true);
            expect(s.isRedirecting, 'the flag cleared once the load landed').toBe(false);
            expect(s.path).toBe('/b1015');
            expect(w.errors).toEqual([]);
        });
    }

    test('03 a late href with download: the browser downloads the file, nothing is loaded into the popin', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        await setLate(page, 'a.lateD', { href: '/b1015/file', download: '' });
        const download = page.waitForEvent('download', { timeout: 5000 });
        await page.click('dialog[open] #frag a.lateD', at);
        const d = await download;
        await page.waitForTimeout(300);
        const s = await readState(page, 'D');
        console.log('[B1015 03]', d.url().replace(BASE, ''), JSON.stringify(s), 'reqs', JSON.stringify(reqs.file), 'prefix-bundle hits', routeHits.n);
        expect(d.url()).toBe(BASE + '/b1015/file');
        expect(reqs.file.filter((r) => /^xhr /.test(r))).toEqual([]);
        expect(s.fileText, 'the file is not written into the popin').toBe(false);
        expect(s.isRedirecting).toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('04 a late href with a target: the browser opens that window', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        await setLate(page, 'a.lateT', { href: '/b1015/win', target: 'b1015win' });
        const popup = page.waitForEvent('popup', { timeout: 5000 });
        await page.click('dialog[open] #frag a.lateT', at);
        const p = await popup;
        await p.waitForLoadState('domcontentloaded');
        const s = await readState(page, 'D');
        console.log('[B1015 04]', p.url().replace(BASE, ''), JSON.stringify(s), 'reqs', JSON.stringify(reqs.win), 'prefix-bundle hits', routeHits.n);
        expect(p.url()).toBe(BASE + '/b1015/win');
        expect(reqs.win).toEqual(['document /b1015/win']);
        expect(s.loaded, 'nothing is loaded into the popin').toEqual([]);
        expect(s.isRedirecting).toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('05 a late tel: href: the click is not prevented, and nothing is requested', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits } = await openScene(page);
        await setLate(page, 'a.lateTel', { href: 'tel:+15550100' });
        await watchPrevented(page, '#frag a.lateTel');
        await page.click('dialog[open] #frag a.lateTel', at);
        await page.waitForTimeout(600);
        const s = await readState(page, 'D');
        const dp = await prevented(page);
        console.log('[B1015 05]', 'prevented', JSON.stringify(dp), JSON.stringify(s), 'other schemes', JSON.stringify(w.otherSchemes), 'prefix-bundle hits', routeHits.n);
        expect(dp, 'the click\'s default goes ahead').toEqual([false]);
        expect(w.otherSchemes.filter((r) => /^xhr /.test(r))).toEqual([]);
        expect(s.isRedirecting).toBe(false);
        expect(s.isOpen).toBe(true);
        expect(w.errors).toEqual([]);
    });

    test('06 a link bound with its href and download: the browser downloads the file, nothing is requested by XHR', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        const download = page.waitForEvent('download', { timeout: 5000 });
        await page.click('dialog[open] #frag a.bindD', at);
        const d = await download;
        await page.waitForTimeout(300);
        const s = await readState(page, 'D');
        console.log('[B1015 06]', d.url().replace(BASE, ''), JSON.stringify(s), 'reqs', JSON.stringify(reqs.file), 'prefix-bundle hits', routeHits.n);
        expect(d.url()).toBe(BASE + '/b1015/file');
        expect(reqs.file.filter((r) => /^xhr /.test(r))).toEqual([]);
        expect(s.fileText).toBe(false);
        expect(s.isRedirecting).toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('07 a link bound with a mailto: href: the click is not prevented, nothing is requested, no error', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits } = await openScene(page);
        await watchPrevented(page, '#frag a.bindM');
        await page.click('dialog[open] #frag a.bindM', at);
        await page.waitForTimeout(600);
        const s = await readState(page, 'D');
        const dp = await prevented(page);
        console.log('[B1015 07]', 'prevented', JSON.stringify(dp), JSON.stringify(s), 'other schemes', JSON.stringify(w.otherSchemes), 'console errors', JSON.stringify(w.consoleErrors), 'prefix-bundle hits', routeHits.n);
        expect(dp, 'the click\'s default goes ahead').toEqual([false]);
        expect(w.otherSchemes.filter((r) => /^xhr /.test(r))).toEqual([]);
        expect(w.consoleErrors).toEqual([]);
        expect(s.isRedirecting).toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('08 a partial swap: a late href written before the swap loads when clicked after it, and the popin then closes', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openSceneS(page);
        await page.click('dialog[open] #fragS a.slate', at);
        await page.waitForSelector('dialog[open] #snextBody', { timeout: 8000 });
        await page.waitForTimeout(200);
        const s = await readState(page, 'S');
        await close(page, 'S');
        await page.waitForTimeout(500);
        const after = await readState(page, 'S');
        console.log('[B1015 08]', JSON.stringify(s), 'after close', JSON.stringify(after), 'reqs', JSON.stringify(reqs.snext), 'prefix-bundle hits', routeHits.n);
        expect(reqs.snext).toEqual(['xhr /b1015/snext']);
        expect(s.isRedirecting).toBe(false);
        expect(after.isOpen, 'gina.popin.close() closed the popin').toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('09 a popin registered with the validator: a download link in a form carrying inherited data is downloaded from its href as written', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openSceneV(page);
        const download = page.waitForEvent('download', { timeout: 5000 });
        await page.click('dialog[open] #vfrag a.vdl', at);
        const d = await download;
        await page.waitForTimeout(300);
        const href = await page.evaluate(() => document.querySelector('#vfrag a.vdl').getAttribute('href'));
        console.log('[B1015 09]', d.url().replace(BASE, ''), 'href', href, 'reqs', JSON.stringify(reqs.file), 'prefix-bundle hits', routeHits.n);
        expect(d.url()).toBe(BASE + '/b1015/file');
        expect(href, 'the link keeps its href').toBe('/b1015/file');
        expect(reqs.file.filter((r) => /^xhr /.test(r))).toEqual([]);
        expect(w.errors).toEqual([]);
    });

    test('10 the same popin: a late href in that form loads, with no ?inheritedData', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openSceneV(page);
        await setLate(page, '#vfrag a.vlate', { href: '/b1015/vlate' });
        await page.click('dialog[open] #vfrag a.vlate', at);
        await page.waitForSelector('dialog[open] #vlateBody', { timeout: 8000 });
        const s = await readState(page, 'V');
        console.log('[B1015 10]', JSON.stringify(s), 'reqs', JSON.stringify(reqs.vlate), 'prefix-bundle hits', routeHits.n);
        expect(reqs.vlate).toEqual(['xhr /b1015/vlate']);
        expect(s.isRedirecting).toBe(false);
        expect(w.errors).toEqual([]);
    });

    test('11 CONTROL a plain link loads into the popin by XHR', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag a.plain', at);
        await page.waitForSelector('dialog[open] #plainBody', { timeout: 8000 });
        const s = await readState(page, 'D');
        console.log('[B1015 11]', JSON.stringify(s), 'reqs', JSON.stringify(reqs.plain), 'prefix-bundle hits', routeHits.n);
        expect(reqs.plain).toEqual(['xhr /b1015/plain']);
        expect(s.path).toBe('/b1015');
        expect(s.isOpen).toBe(true);
        expect(w.errors).toEqual([]);
    });

    test('12 CONTROL a late href, then disabled: nothing is requested, and no redirect starts', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        await setLate(page, 'a.lateX', { href: '/b1015/next', disabled: '' });
        await page.click('dialog[open] #frag a.lateX', at);
        await page.waitForTimeout(800);
        const s = await readState(page, 'D');
        console.log('[B1015 12]', JSON.stringify(s), 'reqs', JSON.stringify(reqs.next), 'prefix-bundle hits', routeHits.n);
        expect(reqs.next).toEqual([]);
        expect(s.isRedirecting).toBe(false);
        expect(s.path).toBe('/b1015');
        expect(w.errors).toEqual([]);
    });

    test('13 CONTROL a link with its own id closes the popin', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openScene(page);
        await page.click('dialog[open] #frag #own-b1015', at);
        await page.waitForTimeout(800);
        const s = await readState(page, 'D');
        console.log('[B1015 13]', JSON.stringify(s), 'reqs', JSON.stringify(reqs.own), 'prefix-bundle hits', routeHits.n);
        expect(s.isOpen).toBe(false);
        expect(reqs.own).toEqual([]);
        expect(w.errors).toEqual([]);
    });

    test('14 CONTROL an in-page # link: the click is not prevented', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits } = await openScene(page);
        await watchPrevented(page, '#frag a.hash');
        await page.click('dialog[open] #frag a.hash', at);
        await page.waitForTimeout(400);
        const s = await readState(page, 'D');
        const dp = await prevented(page);
        console.log('[B1015 14]', 'prevented', JSON.stringify(dp), JSON.stringify(s), 'prefix-bundle hits', routeHits.n);
        expect(dp).toEqual([false]);
        expect(s.path).toBe('/b1015#frag-text');
        expect(w.errors).toEqual([]);
    });

    test('15 CONTROL the validator popin: a plain link in that form loads with the inherited data in its query', async ({ page }) => {
        const w = watchPage(page);
        const { routeHits, reqs } = await openSceneV(page);
        await page.click('dialog[open] #vfrag a.vlink', at);
        await page.waitForSelector('dialog[open] #vnextBody', { timeout: 8000 });
        const s = await readState(page, 'V');
        console.log('[B1015 15]', JSON.stringify(s), 'reqs', JSON.stringify(reqs.vnext), 'prefix-bundle hits', routeHits.n);
        expect(reqs.vnext).toEqual(['xhr /b1015/vnext?inheritedData=%7B%22k%22%3A1%7D']);
        expect(s.isOpen).toBe(true);
        expect(w.errors).toEqual([]);
    });
});
