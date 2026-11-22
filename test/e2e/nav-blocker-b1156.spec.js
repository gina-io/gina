'use strict';

/**
 * #B1156 — a link that the server answers from a route the navigation module cannot match exactly
 * is not intercepted, even when a later route would match it and declare `negotiate: true`.
 *
 * The server reads `/b56/page:number` as `/b56/:number`, so it answers `/b56/page2` from that route.
 * Before the fix gina/nav skipped the route it could not compile and intercepted the click on the
 * later negotiable `/b56/:slug`: one fragment request, answered without `Vary: X-Gina-Navigate` (a
 * non-negotiable route never sets it), an `error` event, then a full page load.
 *
 * Drives the real built bundle (runtime-server.js serves the committed dist). The page rides
 * /x76-page?b64=; the routing table and the link's answers come from page.route, as the
 * nav-popin-close-focus-b762 spec does. Each arm clicks one link and reads the fragment requests,
 * the document loads, whether the document survived and gina.nav's events.
 *
 *   01 CONTROL a negotiable route alone: one fragment request, swapped, no document load
 *   02 CONTROL a compilable non-negotiable route first: no fragment request, one document load
 *   03 a `page:number` route first, then a negotiable `/:slug`: not intercepted (one document load,
 *      no fragment request, no `error`), and gina.nav.matchUrl() answers null
 *
 * Run:
 *   npx playwright test test/e2e/nav-blocker-b1156.spec.js
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const page = (href) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>nav blocker</title>'
    + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
    + '<script>window.__pageInstance = String(Math.random()).slice(2);</script>'
    + '<script src="/js/gina.onload.b459.js"></script><script src="/js/gina.min.js"></script>'
    + '<script>' + KICKER + '</script></head><body>'
    + '<main data-gina-nav><div id="frag-home"><h2 id="frag-title">HOME</h2>'
    + '<p><a id="go" href="' + href + '">go</a></p></div></main></body></html>';

const full = (by) => '<!DOCTYPE html><html><head><title>full page</title></head><body><p id="served-by">served by ' + by + '</p></body></html>';
const NEXT = '<div id="frag-next" data-gina-nav-title="Next"><h2 id="frag-title">NEXT</h2></div>';

// `bundle` must equal the b459 whisper's page.environment.bundle ('e2e')
const RB = (url, extra) => Object.assign({ bundle: 'e2e', method: 'get', url: url }, extra);
const SLUG = RB('/b56/:slug', { negotiate: true, param: { control: 'b', slug: ':slug' } });

/** Wire the routes, load the page, click the link; returns what happened. */
async function drive(pw, routing, href, servedBy) {
    const sink = { fragment: [], document: [], events: [], errors: [] };
    await pw.exposeFunction('__b56report', (s) => { sink.events.push(JSON.parse(s)); });
    pw.on('pageerror', (e) => sink.errors.push(String((e && e.message) || e)));
    await pw.route('**/_gina/assets/routing.json', (route) => route.fulfill({
        status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(routing) }));
    await pw.route('**/b56/**', (route) => {
        const req = route.request();
        if (/fragment/i.test(req.headers()['x-gina-navigate'] || '')) {
            sink.fragment.push(new URL(req.url()).pathname);
            if (servedBy === 'b') {
                return route.fulfill({ status: 200, body: NEXT, headers: {
                    'Content-Type': 'text/html; charset=utf-8', 'Vary': 'X-Gina-Navigate', 'Cache-Control': 'no-store' } });
            }
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: full(servedBy) });
        }
        sink.document.push(new URL(req.url()).pathname);
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: full(servedBy) });
    });
    await pw.goto(BASE + 'x76-page?b64=' + Buffer.from(page(href), 'utf8').toString('base64url'));
    await pw.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasNavHandler === true),
        null, { timeout: 15000 });
    const matched = await pw.evaluate((h) => {
        const rep = (name) => (e) => {
            const d = (e && typeof e.detail !== 'undefined') ? e.detail : e;
            window.__b56report(JSON.stringify({ ev: name, error: d && d.error }));
        };
        window.gina.nav.on('success', rep('success'));
        window.gina.nav.on('error', rep('error'));
        const m = window.gina.nav.matchUrl(h);
        return m ? m.rule : null;
    }, href);
    const before = await pw.evaluate(() => window.__pageInstance);
    await pw.waitForTimeout(400);
    await pw.click('#go');
    await pw.waitForTimeout(2500);
    await pw.waitForLoadState('load');
    const after = await pw.evaluate(() => {
        const t = document.getElementById('frag-title'), s = document.getElementById('served-by');
        return { inst: window.__pageInstance || null, title: t ? t.textContent.trim() : null,
                 servedBy: s ? s.textContent.trim() : null, path: location.pathname };
    });
    return { matched, sameDocument: !!before && before === after.inst, after, sink };
}

test.describe('#B1156 — a route the navigation module cannot match exactly still blocks', () => {

    test('01 CONTROL a negotiable route alone: one fragment request, swapped', async ({ page: pw }) => {
        const r = await drive(pw, { 'b56-b': SLUG }, '/b56/next', 'b');
        expect(r.matched).toBe('b56-b');
        expect(r.sink.fragment).toEqual(['/b56/next']);
        expect(r.sink.document).toEqual([]);
        expect(r.sameDocument).toBe(true);
        expect(r.after.title).toBe('NEXT');
        expect(r.sink.events.map((e) => e.ev)).toEqual(['success']);
        expect(r.sink.errors).toEqual([]);
    });

    test('02 CONTROL a compilable non-negotiable route first: no interception', async ({ page: pw }) => {
        const routing = { 'b56-a': RB('/b56/page/:number', { requirements: { number: '/^[0-9]+$/' }, param: { control: 'a', number: ':number' } }), 'b56-b': SLUG };
        const r = await drive(pw, routing, '/b56/page/2', 'a');
        expect(r.matched).toBe('b56-a');
        expect(r.sink.fragment).toEqual([]);
        expect(r.sink.document).toEqual(['/b56/page/2']);
        expect(r.after.servedBy).toBe('served by a');
        expect(r.sink.events).toEqual([]);
        expect(r.sink.errors).toEqual([]);
    });

    test('03 a `page:number` route first, then a negotiable `/:slug`: not intercepted', async ({ page: pw }) => {
        const routing = { 'b56-a': RB('/b56/page:number', { param: { control: 'a', number: ':number' } }), 'b56-b': SLUG };
        const r = await drive(pw, routing, '/b56/page2', 'a');
        expect(r.matched).toBe(null);
        expect(r.sink.fragment).toEqual([]);
        expect(r.sink.document).toEqual(['/b56/page2']);
        expect(r.after.servedBy).toBe('served by a');
        expect(r.sink.events).toEqual([]);
        expect(r.sink.errors).toEqual([]);
    });
});
