'use strict';

/**
 * Playwright RUNTIME e2e for #B585 — `reBind()` must not stack the validator's listeners,
 * and `destroy()` must detach them (the real built gina bundle, a real form, real clicks).
 *
 * The defect: `unbindForm` detached nothing. Its nine form-level `removeListener` calls
 * passed the validator's RECORD (which has no `removeEventListener`), and every per-element
 * call omitted the handler, so only the `gina.events` registry keys went. `bindForm` then
 * re-attached every form-level listener (the native proxies are unguarded, the others are
 * guarded by the keys that had just been deleted), so each `reBind()` added one more copy of
 * each: measured 1 → 3 after two `reBind()` on this very scene (2026-10-06). Two consumer-
 * visible side effects: the submit proxy picks its channel from `gina.events['submit.<id>']`,
 * which unbind deleted, so a consumer's `.on('submit')` handler was BYPASSED after a reBind
 * (the validator sent the form itself); and a consumer re-registering `.on()` after a reBind
 * attached a second wrapper beside the surviving first one (its callback ran twice).
 *
 * The fix: `bindForm` records every listener it attaches on a per-form ledger and
 * `unbindForm` drains it by reference; `.on()` records its wrapper on the handle so that
 * `destroy()` can detach consumer handlers too, while `reBind()` leaves them in place.
 *
 * The instrument: an init script wraps `EventTarget.prototype.add/removeEventListener`
 * and keeps a Map of Sets keyed `<element id>|<type>` — a Set, so a handler attached twice
 * with the same reference counts once and distinct closures count separately. Counts are
 * read before and after the operation under test. Every arm is a control for the others:
 *
 *   01 counts stay at 1 after two reBind()          (RED before the fix: 3)
 *   02 a .on('submit') handler still owns the submit after reBind()   (RED: bypassed)
 *   03 re-registering .on('success') after reBind() does not double-fire (RED: fired twice)
 *   04 destroy() leaves 0 listeners, a re-bind + fresh .on() fires once (RED: old handler too —
 *      and on the first cut of the fix, RED the other way: with the stale listeners gone, the
 *      re-bound record had no submit trigger, because the button kept the marker the first bind
 *      wrote; unbindForm now removes it)
 *   05 (webkit only) one keystroke inserts one character after two reBind() — the consumer-
 *      reported Safari symptom (#B135's interception stacks a keydown per re-bind)
 *   06 no listener is registered on `window` under the type "[object Object]" — the by-catch
 *      at main.js:7042 called the browser's own addEventListener with gina's 4-arg shape
 *   07 a form INSIDE A POPIN, re-bound by its own answer: the declared success callback runs
 *      for the first submit (the popin teardown destroy()s the old form AFTER the content was
 *      replaced, so its `.on()` handlers are kept for the dispatch that follows) and exactly
 *      once more for a second submit of the re-bound form (its keys were released, so the
 *      successor's own hook registered). Its callback half is a CONTROL for the destroy()
 *      rule on both sides of the fix (the first cut of the fix drained the detached form's
 *      handlers and read 0 here); its count half is RED before the fix — the destroyed form's
 *      own listeners survived on the old element, which shares the id the ledger keys on.
 *
 * Scene: /autocomplete — `acform` (rule: `ref` isRequired), sink /ac-sink answers {}; arm 07
 * builds its own popin page through page.route (the gh#76 harness shape).
 *
 * Pre-fix arm: `GINA_B585_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle
 * to the page instead of the working-tree dist (the plugins subtract recipe). Measured on
 * 8e643d9d3's bytes (2026-10-07): 01 red (3 ≠ 1), 02 red (the validator sent the form
 * itself: handler 0), 03 red (fired twice), 04 red (the destroyed binding's listeners still
 * attached), 06 red (one listener on window), 07 red (2 listeners on the re-bound form).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B585_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B585_PREFIX_BUNDLE) : null;
async function servePrefixBundle(page) {
    if (!PREFIX_BUNDLE) { return null; }
    const hits = { n: 0 };
    await page.route('**/js/gina.min.js', (r) => { hits.n++; r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    return hits;
}

// Live-listener ledger: per element id (or window/document) + event type, the set of
// functions attached. Installed before any page script runs.
const LEDGER = `(() => {
    var add = EventTarget.prototype.addEventListener, rm = EventTarget.prototype.removeEventListener;
    window.__lc = {};
    function key(t, type) {
        var id = (t === window) ? 'window' : (t === document) ? 'document' : ((t && t.id) || '?');
        return id + '|' + type;
    }
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
        var k = key(this, type); (window.__lc[k] = window.__lc[k] || new Set()).add(fn);
        return add.call(this, type, fn, opt);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opt) {
        var k = key(this, type); if (window.__lc[k]) { window.__lc[k].delete(fn); }
        return rm.call(this, type, fn, opt);
    };
})();`;

// What one bind attaches on the form, on the live-checked field and on the submit trigger.
const FORM_TYPES    = ['validate.acform', 'reset.acform', 'submit', 'reset', 'keydown', 'keyup', 'focusin', 'focusout', 'change', 'click', 'animationstart'];
const FIELD_TYPES   = ['change.ref-input', 'keyup.ref-input', 'focusin.ref-input', 'focusout.ref-input'];
// a <button> trigger gets no preventDefault click listener (anchors only, main.js bindSubmitEl's caller)
const TRIGGER_TYPES = ['submit.acform-submit'];

async function bootAutocomplete(page) {
    await page.addInitScript(LEDGER);
    const prefix = await servePrefixBundle(page);
    await page.goto(BASE + 'autocomplete');
    await page.waitForFunction(() => !!(
        window.gina
        && window.gina.validator
        && window.gina.validator.$forms
        && window.gina.validator.$forms.acform
        && window.gina.validator.$forms.acform.binded
    ), null, { timeout: 15000 });
    if (prefix) { expect(prefix.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
}

/**
 * A NATIVE submit event — the only path that consults `on('submit')`: the form-level submit proxy
 * reads `gina.events['submit.<id>']`, while a click on the trigger (and implicit submission by
 * Enter, which clicks the default button when the form has one — measured: handler 0 on both
 * sides) ends in bindSubmitEl's listener, which dispatches `validate.<id>` directly.
 * `requestSubmit()` fires a TRUSTED submit without clicking the button, so it is the realistic
 * programmatic shape here — and the #B308 gate reads the LIVE trigger: `fill()` fires `input`,
 * which the live check does not listen to, so the field is blurred first (`focusout` runs the
 * live check and un-gates the trigger); without it the gate refuses the submit with a reveal
 * (measured: handler 0 on both sides, the trigger un-gated only after the refusal).
 */
async function fillAndSubmitNatively(page) {
    await page.fill('#ref-input', 'ABC');
    await page.locator('#ref-input').blur();
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('acform').requestSubmit(); });
    await page.waitForTimeout(1500);
}

/** The ledger's counts for one element id: { '<type>': <distinct handlers> }. */
function counts(page, id) {
    return page.evaluate((id) => {
        var out = {};
        Object.keys(window.__lc).forEach(function (k) {
            if (k.indexOf(id + '|') === 0) { out[k.slice(id.length + 1)] = window.__lc[k].size; }
        });
        return out;
    }, id);
}

function expectEach(actual, types, n, label) {
    types.forEach(function (t) {
        expect(actual[t], label + ': ' + t).toBe(n);
    });
}

function countPosts(page) {
    const posts = [];
    page.on('request', (r) => {
        if (r.url().indexOf('/ac-sink') > -1 && r.method() === 'POST') { posts.push(1); }
    });
    return posts;
}

async function reBindTwice(page) {
    await page.evaluate(() => {
        window.gina.validator.$forms.acform.reBind();
        window.gina.validator.$forms.acform.reBind();
    });
}

async function fillAndSubmit(page) {
    await page.fill('#ref-input', 'ABC');
    await page.waitForTimeout(400);
    await page.click('#acform-submit', { force: true });
    await page.waitForTimeout(1500);
}

test.describe('#B585 — reBind() does not stack listeners; destroy() detaches them', function () {

    test('01 - after two reBind() every listener of one bind is attached exactly once', async ({ page }) => {
        await bootAutocomplete(page);

        // positive control: the scene attaches each of them once on the first bind
        const before = await counts(page, 'acform');
        expectEach(before, FORM_TYPES, 1, 'after the first bind, form');
        expectEach(await counts(page, 'ref-input'), FIELD_TYPES, 1, 'after the first bind, field');
        expectEach(await counts(page, 'acform-submit'), TRIGGER_TYPES, 1, 'after the first bind, trigger');

        await reBindTwice(page);

        expectEach(await counts(page, 'acform'), FORM_TYPES, 1, 'after two reBind(), form');
        expectEach(await counts(page, 'ref-input'), FIELD_TYPES, 1, 'after two reBind(), field');
        expectEach(await counts(page, 'acform-submit'), TRIGGER_TYPES, 1, 'after two reBind(), trigger');
    });

    test('02 - a consumer .on(\'submit\') handler still owns the submit after reBind()', async ({ page }) => {
        // the submit proxy on the FORM reads `gina.events['submit.<id>']` to pick the consumer channel;
        // a click on the trigger never consults it (bindSubmitEl's listener validates and sends), so
        // the arm drives a native submit — `requestSubmit()` on the blurred, filled form
        const posts = countPosts(page);
        await bootAutocomplete(page);
        await page.evaluate(() => {
            window.__submitSeen = 0;
            window.gina.validator.$forms.acform.on('submit', function () { window.__submitSeen++; });
        });

        await reBindTwice(page);
        await fillAndSubmitNatively(page);

        expect(await page.evaluate(() => window.__submitSeen), 'the consumer handler took the submit').toBe(1);
        expect(posts.length, 'the validator did not send the form itself').toBe(0);
    });

    test('03 - a .on(\'success\') handler fires once after reBind(), and re-registering does not double it', async ({ page }) => {
        countPosts(page);
        await bootAutocomplete(page);
        await page.evaluate(() => {
            window.__first = 0; window.__second = 0;
            window.gina.validator.$forms.acform.on('success', function () { window.__first++; });
        });

        await reBindTwice(page);
        // the add-once contract: the first registration is still attached, so this one is dropped
        await page.evaluate(() => {
            window.gina.validator.$forms.acform.on('success', function () { window.__second++; });
        });
        await fillAndSubmit(page);

        expect(await page.evaluate(() => window.__first), 'the handler registered before reBind() fired once').toBe(1);
        expect(await page.evaluate(() => window.__second), 'the re-registration was dropped, not stacked').toBe(0);
    });

    test('04 - destroy() leaves no listener behind, consumer handlers included; a re-bind starts clean', async ({ page }) => {
        countPosts(page);
        await bootAutocomplete(page);
        await page.evaluate(() => {
            window.__old = 0; window.__new = 0;
            window.gina.validator.$forms.acform.on('success', function () { window.__old++; });
            window.gina.validator.$forms.acform.destroy();
        });

        const gone = await counts(page, 'acform');
        Object.keys(gone).forEach(function (t) {
            expect(gone[t], 'destroy() detached the form listener: ' + t).toBe(0);
        });
        expectEach(await counts(page, 'ref-input'), FIELD_TYPES, 0, 'destroy() detached the field listeners');
        expect(await page.evaluate(() => typeof window.gina.validator.$forms.acform), 'the record is gone').toBe('undefined');
        expect(await page.evaluate(() => typeof window.gina.events['success.acform']), 'the consumer key is released').toBe('undefined');

        // the consumer idiom: destroy, then bind the same element again
        await page.evaluate(() => { window.gina.validator.validateFormById('acform'); });
        await page.waitForFunction(() => !!(window.gina.validator.$forms.acform && window.gina.validator.$forms.acform.binded), null, { timeout: 10000 });
        expectEach(await counts(page, 'acform'), FORM_TYPES, 1, 'after the re-bind, form');
        expectEach(await counts(page, 'acform-submit'), TRIGGER_TYPES, 1, 'after the re-bind, trigger');
        // the first cut of the fix left the button stamped by the first bind, so the fresh record
        // never claimed it: its state was never updated and the click was refused as gated
        expect(await page.evaluate(() => window.gina.validator.$forms.acform.submitTrigger), 'the re-bound record claimed its submit trigger again').toBe('acform-submit');
        await page.evaluate(() => {
            window.gina.validator.$forms.acform.on('success', function () { window.__new++; });
        });
        await fillAndSubmit(page);

        expect(await page.evaluate(() => window.__new), 'the fresh handler fired once').toBe(1);
        expect(await page.evaluate(() => window.__old), 'the destroyed binding\'s handler is gone').toBe(0);
    });

    test('05 - (webkit only) one keystroke inserts one character after two reBind()', async ({ page, browserName }) => {
        test.skip(browserName !== 'webkit', 'the autocomplete interception is gated to REAL Safari UAs (#B135); only the webkit project carries one');
        await bootAutocomplete(page);
        await reBindTwice(page);

        await page.click('#ref-input');
        await page.keyboard.type('a');
        await page.waitForTimeout(300);

        expect(await page.inputValue('#ref-input'), 'one keystroke, one character').toBe('a');
    });

    test('06 - nothing is registered on window under the type "[object Object]"', async ({ page }) => {
        await bootAutocomplete(page);
        const onWindow = await counts(page, 'window');
        expect(onWindow['[object Object]'] || 0, 'main.js:7042 no longer calls the browser addEventListener with the gina shape').toBe(0);
    });

    test('07 - a form inside a popin, re-bound by its own answer: the declared callback runs once per submit', async ({ page }) => {
        // The gh#76 harness shape: a page built through page.route, a legacy trigger with the
        // preload opted out, a popin registered WITH the validator so the loaded form is bound,
        // and a sink whose text/html answer carries the SAME form again plus the two hidden
        // transport inputs, so the popin is re-filled with a bindable form after each submit.
        const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
            + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
            + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
            + '&&t++<100){setTimeout(k,50);}}k();}());';
        const RECORDER = 'window.__b585={success:0,error:0};'
            + 'window.onRowSaved=function(){window.__b585.success++;};'
            + 'window.onRowError=function(){window.__b585.error++;};';
        const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b585</title>'
            + '<link rel="icon" href="data:,"><link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
            + '<script src="/js/gina.onload.hform.js"></script><script src="/js/gina.min.js"></script>'
            + '<script>' + KICKER + RECORDER + '</script></head><body><h1>b585</h1>'
            + '<button data-gina-popin-name="b585" data-gina-popin-url="/frag/b585.html" data-gina-dialog-preload="false">Open</button>'
            + '</body></html>';
        const FRAG_WITH_FORM = '<div id="b585-frag"><p>popin content</p>'
            + '<form id="pform" data-gina-form-rule="hformform" data-gina-form-event-on-submit-success="onRowSaved" data-gina-form-event-on-submit-error="onRowError" action="/b585/save" method="post">'
            + '<input name="ref" value="in-popin"><button id="pform-submit" type="submit">Save</button></form></div>';
        const XHR_INPUTS = '<input type="hidden" id="gina-without-layout-xhr-data" value="%7B%22ok%22%3Atrue%7D">'
            + '<input type="hidden" id="gina-without-layout-xhr-view" value="%7B%7D">';
        const saves = [];
        await page.route('**/b585', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.route('**/frag/b585.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAG_WITH_FORM }));
        await page.route('**/b585/save', (r) => { saves.push(1); r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FRAG_WITH_FORM.replace('popin content', 'saved ' + saves.length) + XHR_INPUTS }); });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
        await page.addInitScript(LEDGER);
        const prefix = await servePrefixBundle(page);
        await page.goto(BASE + 'b585');
        await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.hasPopinHandler === true && window.gina.validator), null, { timeout: 15000 });
        if (prefix) { expect(prefix.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
        const reg = await page.evaluate(() => new Promise((resolve) => {
            setTimeout(() => resolve('TIMEOUT'), 8000);
            window.require(['gina/popin'], function (Popin) {
                new Popin({ name: 'b585', validator: window.gina.validator }).on('ready', function () { resolve('READY'); });
            });
        }));
        expect(reg, 'the popin must register').toBe('READY');

        await page.click('[data-gina-popin-name="b585"]');
        await page.waitForFunction(() => !!(document.getElementById('pform') && window.gina.validator.$forms && window.gina.validator.$forms.pform && window.gina.validator.$forms.pform.binded), null, { timeout: 8000 });
        await page.waitForTimeout(200);

        // first submit: the answer replaces the popin content (the old form is destroyed detached)
        const req1 = page.waitForRequest((r) => r.url().endsWith('/b585/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req1;
        await page.waitForTimeout(1500);
        expect(await page.evaluate(() => window.__b585.success), 'the declared callback ran for the first submit').toBe(1);
        expect(await page.evaluate(() => /saved 1/.test(document.querySelector('dialog[open]').innerHTML)), 'the popin shows the first answer').toBe(true);
        // the successor is bound, once: each form-level listener of one bind is attached exactly once
        await page.waitForFunction(() => !!(window.gina.validator.$forms.pform && window.gina.validator.$forms.pform.binded), null, { timeout: 8000 });
        const after1 = await counts(page, 'pform');
        expectEach(after1, ['validate.pform', 'submit', 'keydown', 'click'], 1, 'the re-bound form');

        // second submit, on the re-bound form: exactly one more callback (its own hook registered,
        // because destroy() released the keys; the old wrapper died with the old element)
        const req2 = page.waitForRequest((r) => r.url().endsWith('/b585/save'), { timeout: 5000 });
        await page.click('#pform-submit'); await req2;
        await page.waitForTimeout(1500);
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => window.__b585.error), 'no error callback').toBe(0);
        expect(saves.length, 'two requests').toBe(2);
        expect(await page.evaluate(() => window.__b585.success), 'the declared callback ran exactly once more').toBe(2);
        expect(await page.evaluate(() => /saved 2/.test(document.querySelector('dialog[open]').innerHTML)), 'the popin shows the second answer').toBe(true);
    });
});
