'use strict';

/**
 * #B756, the client-navigation path: a validator popin that is still open when a client
 * navigation swaps the page must have its forms torn down, so the reopened form is bound again.
 *
 * gina/nav closes the active popin after every successful fragment swap (nav/main.js
 * `closeActivePopin`), through `gina.popin.close(name)` on the boot instance: the call #B756
 * fixed. test/e2e/validator-upload-popin-reopen-b733.spec.js test 04 makes that call directly;
 * this spec reaches it through a navigation.
 *
 * Same scene as the b733 spec: runtime-server.js serves the committed dist, the page rides
 * /x76-page?b64=, the popin body and the staging route are page.route'd, and the popin is
 * registered WITH the validator and opened through a LEGACY trigger. Added: a `data-gina-nav`
 * region, with the legacy trigger outside it so the trigger survives the swap. The harness serves
 * nav's routing table only to pages under /nav, so this spec answers /_gina/assets/routing.json
 * itself with one negotiable route, and answers that route's fragment request with
 * `Vary: X-Gina-Navigate`. The navigation is `gina.nav.navigate()`, the same pipeline as an
 * intercepted click (a click cannot reach the page behind the modal popin).
 *
 * A full-page fallback would boot a fresh page that binds its forms anyway, which must not pass
 * for a teardown. So every navigation is checked to be a fragment swap: its request carried
 * `X-Gina-Navigate`, the region shows the fragment, and the document was not reloaded
 * (`window.__pageInstance` unchanged; test 01 shows that a real reload does change it).
 *
 * RED-FIRST, measured 2026-10-03 by serving the committed dist of `1c63c4dcd` (#B733 fixed,
 * #B756 not) and of `761631fb4` (neither) in place of the current one: test 01 passed on both, so
 * the navigation did swap in place and close the popin; test 02 found the form's validator record
 * still there after the close (`recordAfterClose: true`) and the reopened form unbound
 * (`boundOnReopen: false`), and the second selection sent nothing and threw nothing. Green on the
 * current dist.
 *
 *   01 CONTROL the navigation swaps the region in place and closes the open popin
 *   02 closed by that navigation, reopened: the new selection is staged from the new form
 *
 * Run:
 *   npx playwright test test/e2e/validator-upload-popin-reopen-nav-b756.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

// One negotiable route. `bundle` must equal the b459 whisper's page.environment.bundle ('e2e').
const ROUTING = { 'b756-next': { bundle: 'e2e', method: 'get', url: '/b756/next', param: {}, negotiate: true } };

// the b459 whisper (non-empty: the validator boots), one legacy trigger OUTSIDE the nav region,
// and the region itself. The on-success callback must exist before the first staging send.
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>upload popin nav</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script>window.__pageInstance = String(Math.random()).slice(2); window.__ok = 0;'
    + ' window.onUplOk = function () { window.__ok++; };</script>'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body><h1>upload popin nav</h1>'
    + '<button data-gina-popin-name="upl" data-gina-popin-url="/frag/upl.html" data-gina-dialog-preload="false">Open</button>'
    + '<main data-gina-nav><div id="frag-home"><h2 id="frag-title">HOME</h2></div></main>'
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

// the region the navigation swaps in
const NEXT = '<div id="frag-next" data-gina-nav-title="Next"><h2 id="frag-title">NEXT</h2></div>';

// what a fragment swap looks like, as `navigate()` reports it
const SWAP_OK = { swapped: true, sameDocument: true, fragmentRequests: 1, fullPageRequests: 0, path: '/b756/next' };

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

/** Wire the sinks and the routing table, load the page, register popin `upl` with the validator. */
async function boot(pw) {
    const sink = { errors: [], warnings: [], frag: 0, stage: [], navFragment: 0, navFull: 0 };
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    pw.on('console', (m) => { if (m.type() === 'warning') sink.warnings.push(m.text()); });
    await pw.route('**/_gina/assets/routing.json', (route) => route.fulfill({
        status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(ROUTING) }));
    await pw.route('**/b756/next', (route) => {
        if (/fragment/i.test(route.request().headers()['x-gina-navigate'] || '')) {
            sink.navFragment++;
            return route.fulfill({ status: 200, body: NEXT, headers: {
                'Content-Type': 'text/html; charset=utf-8', 'Vary': 'X-Gina-Navigate', 'Cache-Control': 'no-store' } });
        }
        // a full-page navigation: a page without the framework, so the scene cannot continue unnoticed
        sink.navFull++;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            body: '<!DOCTYPE html><html><head><title>full page</title></head><body><p>full page</p></body></html>' });
    });
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
        && window.gina.hasPopinHandler === true && window.gina.validator
        && window.gina.hasNavHandler === true), null, { timeout: 15000 });
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

/** Navigate to /b756/next through gina/nav; returns what the navigation looked like (see SWAP_OK). */
async function navigate(pw, sink) {
    const before = await pw.evaluate(() => window.__pageInstance);
    await pw.evaluate(() => { window.gina.nav.navigate('/b756/next'); });
    const swapped = await pw.waitForFunction(() => {
        const t = document.getElementById('frag-title');
        return !!(t && t.textContent.trim() === 'NEXT');
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
    const after = await pw.evaluate(() => window.__pageInstance).catch(() => null);
    return { swapped: swapped, sameDocument: !!before && before === after, fragmentRequests: sink.navFragment,
        fullPageRequests: sink.navFull, path: new URL(pw.url()).pathname };
}

/** Has popin `upl` closed? false on timeout, never a throw. */
function closed(pw) {
    return pw.waitForFunction(() => {
        const p = window.gina.popin.getPopinByName('upl');
        return !!(p && !p.isOpen);
    }, null, { timeout: 5000 }).then(() => true).catch(() => false);
}

test.describe('#B756 — a validator popin closed by a client navigation', () => {

    test('01 CONTROL the navigation swaps the region in place and closes the open popin', async ({ page: pw }) => {
        const sink = await boot(pw);
        await openPopin(pw);
        expect(await boundToLiveNode(pw), 'reader check: the first open IS bound (must read true)').toBe(true);
        expect(await navigate(pw, sink)).toEqual(SWAP_OK);
        expect(await closed(pw), 'the navigation must close the open popin').toBe(true);
        expect(sink.errors).toEqual([]);
        // reader check for `sameDocument`: a real reload DOES change the instance
        const before = await pw.evaluate(() => window.__pageInstance);
        await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(PAGE, 'utf8').toString('base64url'));
        expect(await pw.evaluate(() => window.__pageInstance), 'a reload must change the instance').not.toBe(before);
    });

    test('02 closed by that navigation, reopened: the new selection is staged from the new form', async ({ page: pw }) => {
        const sink = await boot(pw);
        await openPopin(pw);
        await stage(pw, 'one.png');
        await expect.poll(() => sink.stage.length, { timeout: 5000 }).toBe(1);
        expect(await filledWith(pw, 'one.png'), 'scene premise: the first open stages and fills').toBe(true);
        expect(await navigate(pw, sink), 'scene premise: the navigation is a fragment swap').toEqual(SWAP_OK);
        expect(await closed(pw), 'scene premise: the navigation closes the popin').toBe(true);
        await pw.waitForTimeout(400);
        // the teardown itself: it deletes the form's validator record
        const recordAfterClose = await pw.evaluate(() => !!(window.gina.validator.$forms
            && window.gina.validator.$forms['b459form']));
        const liveAfterClose = await boundToLiveNode(pw);
        const popinId = await openPopin(pw);
        const bound = await boundToLiveNode(pw);
        await stage(pw, 'two.png');
        const filled = await filledWith(pw, 'two.png');
        await pw.waitForTimeout(300);
        expect({
            frag: sink.frag, recordAfterClose: recordAfterClose, liveAfterClose: liveAfterClose, boundOnReopen: bound,
            staged: sink.stage.map((s) => s.name), secondFromPopin: !!(sink.stage[1] && sink.stage[1].popinId === popinId),
            filled: filled, onSuccessCalls: await pw.evaluate(() => window.__ok), errors: sink.errors.slice(),
            teardownWarnings: sink.warnings.filter((w) => /popin teardown/.test(w))
        }).toEqual({
            frag: 2, recordAfterClose: false, liveAfterClose: false, boundOnReopen: true, staged: ['one.png', 'two.png'],
            secondFromPopin: true, filled: true, onSuccessCalls: 2, errors: [], teardownWarnings: []
        });
    });
});
