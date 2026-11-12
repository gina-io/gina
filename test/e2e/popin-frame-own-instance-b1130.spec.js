'use strict';

/**
 * #B1130 (gh#103) — a gina page in a same-origin frame of another gina page boots its OWN instance.
 *
 * Before the fix, `construct()` (vendor/gina/main.js) merged the parent frame's `gina` into the
 * frame's, and lib/merge keeps the target's values, so the frame kept the parent's per-document
 * state: `isFrameworkLoaded` (the frame's own loader returned at once: its config, forms, session
 * and stylesheet never applied), `hasPopinHandler` + `popinContainer` (the popin boot was skipped,
 * the declarative trigger did nothing, and `new Popin()` looked up the parent's container in the
 * frame's document: `TypeError: Cannot read properties of undefined (reading 'addListener')`), and
 * the parent's popin and `setOptions` closures. Reproduced in Chromium on develop fbdf80b29.
 *
 * Scene: two pages served from memory (page.route, zero fixtures) on gina's runtime server: a
 * parent that boots the client, and a child — a gina page with an in-page dialog and its trigger —
 * inserted as a same-origin <iframe> once the parent's popin handler has booted (a page that adds
 * frames later). The child's loader is the real onload with `bundle:'e2e'` replaced by
 * `bundle:'e2e-child'` (count-guarded), so `gina.config.bundle` tells whose loader applied.
 *
 * Subtract lever: B1130_PREFIX_BUNDLE=<path to a pre-fix gina.min.js> serves that file at the bundle
 * URL (page.route, zero disk mutation); `hits.n` is the evidence it executed. Bare: every test
 * passes; with the lever on the pre-fix bundle: the frame test fails, the direct control passes.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

const KICK = '(function () { var tries = 0; function kick() { try { if (window.gina && window.gina.config'
    + ' && typeof window.onGinaLoaded === "function" && !window.gina.isFrameworkLoaded) { window.onGinaLoaded(window.gina); } }'
    + ' catch (e) { window.__errors.push("kick: " + (e && e.message)); }'
    + ' if ((!window.gina || !window.gina.isFrameworkLoaded) && tries++ < 100) { setTimeout(kick, 50); } } kick(); })();';
const TRAP = '<script>window.__errors = [];'
    + 'window.addEventListener("error", function (e) { window.__errors.push("error: " + e.message); });'
    + 'window.addEventListener("unhandledrejection", function (e) { var r = e.reason; window.__errors.push("rejection: " + ((r && r.message) || r)); });'
    + '</script>';
function head(onload) {
    return '<meta charset="utf-8"><link rel="icon" href="data:,">' + TRAP
        + '<script src="' + onload + '"></script><script src="/js/gina.min.js"></script><script>' + KICK + '</script>';
}
const PARENT = '<!DOCTYPE html><html lang="en"><head>' + head('/js/gina.onload.js') + '<title>b1130 parent</title></head>'
    + '<body><div id="frame-slot"></div></body></html>';
const CHILD = '<!DOCTYPE html><html lang="en"><head>' + head('/js/gina.onload.b1130child.js') + '<title>b1130 child</title></head>'
    + '<body><a id="child-trigger" href="#child-dlg" data-gina-dialog="child-dlg">open</a>'
    + '<dialog id="child-dlg"><button class="gina-popin-close" type="button">close</button><p>child dialog</p></dialog></body></html>';

/** The two pages, the child's loader, and the optional pre-fix bundle. Returns the bundle hit counter. */
async function routeScene(page) {
    const hits = { n: 0 };
    if (process.env.B1130_PREFIX_BUNDLE) {
        const body = fs.readFileSync(process.env.B1130_PREFIX_BUNDLE);
        await page.route('**/js/gina.min.js', async (route) => {
            hits.n++;
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
        });
    }
    await page.route('**/js/gina.onload.b1130child.js', async (route) => {
        const resp = await route.fetch({ url: BASE + 'js/gina.onload.js' });
        const body = await resp.text();
        const n = body.split("bundle:'e2e'").length - 1;
        if (n !== 1) { return route.fulfill({ status: 500, contentType: 'text/plain', body: 'onload anchor count ' + n }); }
        await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: body.replace("bundle:'e2e'", "bundle:'e2e-child'") });
    });
    const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body });
    await page.route('**/b1130-parent', (route) => route.fulfill(html(PARENT)));
    await page.route('**/b1130-child', (route) => route.fulfill(html(CHILD)));
    return hits;
}

/** Waits for a document's own boot: the framework loaded and its popin handler booted. */
async function booted(frame) {
    await frame.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true), null, { timeout: 15000 });
}

/** What a document reads of its own state; `inFrame` compares with its parent's objects. */
async function readState(frame) {
    return frame.evaluate(() => {
        const g = window.gina || {};
        let pg = null;
        try { pg = (window.parent !== window) ? window.parent.gina : null; } catch (e) { pg = null; }
        return {
            configBundle: (g.config && g.config.bundle) || null,
            containerHere: !!(g.popinContainer && document.getElementById(g.popinContainer)),
            popinsHere: document.querySelectorAll('.gina-popins').length,
            setOptionsIsParents: !!(pg && g.setOptions === pg.setOptions),
            popinMethodsAreParents: !!(pg && pg.popin && g.popin && g.popin.getActivePopin === pg.popin.getActivePopin)
        };
    });
}

/** `new Popin()` from page code: 'READY', or what it threw. */
async function constructPopin(frame) {
    return frame.evaluate(() => new Promise((resolve) => {
        const t = setTimeout(() => resolve('TIMEOUT'), 4000);
        window.require(['gina/popin'], (Popin) => {
            try { new Popin({ name: 'b1130-page-popin' }).on('ready', () => { clearTimeout(t); resolve('READY'); }); }
            catch (e) { clearTimeout(t); resolve('THREW ' + e.constructor.name + ': ' + e.message); }
        });
    }));
}

/** Clicks the declarative trigger and reports whether the child's dialog opened. */
async function triggerOpens(frame) {
    await frame.click('#child-trigger');
    await frame.waitForTimeout(500);
    return frame.evaluate(() => { const d = document.getElementById('child-dlg'); return !!(d && d.open); });
}

test.describe('#B1130 — a gina page in a same-origin frame boots its own instance', () => {

    test('control: the child page loaded directly boots its own popin', async ({ page }) => {
        const hits = await routeScene(page);
        await page.goto(BASE + 'b1130-child');
        await booted(page.mainFrame());
        const state = await readState(page.mainFrame());
        expect(state.configBundle).toBe('e2e-child');
        expect(state.containerHere).toBe(true);
        expect(await triggerOpens(page.mainFrame())).toBe(true);
        expect(await constructPopin(page.mainFrame())).toBe('READY');
        expect(await page.evaluate(() => window.__errors)).toEqual([]);
        if (process.env.B1130_PREFIX_BUNDLE) { expect(hits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0); }
    });

    test('the child framed in a booted gina page: its own config, container, trigger and Popin; the parent untouched', async ({ page }) => {
        const hits = await routeScene(page);
        await page.goto(BASE + 'b1130-parent');
        await booted(page.mainFrame());
        await page.evaluate(() => {
            const f = document.createElement('iframe');
            f.id = 'child'; f.src = '/b1130-child';
            document.getElementById('frame-slot').appendChild(f);
        });
        const frame = await (await page.waitForSelector('#child')).contentFrame();
        await frame.waitForLoadState('load');
        await booted(frame);
        const state = await readState(frame);
        expect(state.configBundle, 'the frame applied its OWN loader').toBe('e2e-child');
        expect(state.containerHere, 'its popin container is in its own document').toBe(true);
        expect(state.popinsHere).toBe(1);
        expect(state.setOptionsIsParents, 'its setOptions is its own').toBe(false);
        expect(state.popinMethodsAreParents, 'its popin is its own').toBe(false);
        expect(await triggerOpens(frame), 'the declarative trigger opens the frame\'s dialog').toBe(true);
        expect(await constructPopin(frame)).toBe('READY');
        expect(await frame.evaluate(() => window.__errors)).toEqual([]);
        const parent = await readState(page.mainFrame());
        expect(parent.configBundle, 'the parent keeps its own config').toBe('e2e');
        expect(parent.containerHere).toBe(true);
        expect(await page.evaluate(() => window.__errors)).toEqual([]);
        if (process.env.B1130_PREFIX_BUNDLE) { expect(hits.n, 'the pre-fix bundle was not served').toBeGreaterThan(0); }
    });
});
