'use strict';

/**
 * Playwright RUNTIME e2e for #B444 (gh issue #67) — modifier chords on a
 * live-checked autocomplete-suppressed field run NATIVELY, on a REAL WebKit
 * engine with the full gina stack.
 *
 * The defect: the form-level keydown proxy cancelled the NATIVE keydown
 * unconditionally before re-dispatching the namespaced synthetic event, so on
 * a real-Safari UA every chord on a shimmed field was dead — paste inserted
 * nothing and dispatched NO paste/beforeinput event anywhere (preventDefault
 * on the keydown suppresses the editing command itself), select-all selected
 * nothing. The interception handler's #B134 chord bail could not help: it runs
 * one layer below the proxy's cancel. Fixed by dispatching first and
 * cancelling only when the handler prevented the synthetic event.
 *
 * webkit-project-ONLY (same gate as validator-autocomplete-caret.spec.js):
 * the interception registers on real-Safari UAs only (#B135), so on chromium/
 * firefox no 'keydown.<id>' handler exists and the proxy never cancels —
 * every arm would pass vacuously. Runs in the on-demand cross-engine job and
 * locally via:
 *
 *   GINA_E2E_ENGINES=all npx playwright test test/e2e/validator-autocomplete-paste.spec.js --project=webkit
 *
 * Instrument notes:
 *   - Chords are pressed as `ControlOrMeta+…`: Meta on macOS, Control on Linux,
 *     whose WebKit does not run the editing commands for Meta chords (the clipboard
 *     control below read "" there with Meta). gina's chord bail covers both keys.
 *   - The clipboard is seeded by a REAL copy (select-all + copy chord in an
 *     un-bound control input injected post-boot) and proven usable by a REAL
 *     paste into that same control before any arm runs — a can-fire control
 *     for the clipboard instrument itself.
 *   - The typing arm guards the other direction: interception must still hold
 *     (value composed once, not doubled by a leaked native insert).
 *   - Validated red-first against the pre-fix bundle (route-served): paste
 *     read "" and Cmd+A read a collapsed selection, with the clipboard
 *     control firing.
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

test.describe('#B444 — native chords on the autocomplete-intercepted field (webkit only)', () => {

    test.skip(({ browserName }) => browserName !== 'webkit',
        'the interception is gated to REAL Safari UAs (#B135); only the webkit project carries one');

    test.beforeEach(async ({ page }) => {
        await page.goto(BASE + 'autocomplete');
        await page.waitForFunction(() => window.gina && window.gina.isFrameworkLoaded);

        // clipboard seed + can-fire control, in an input gina never binds
        await page.evaluate(() => {
            const c = document.createElement('input');
            c.type = 'text'; c.id = 'clip-control';
            document.body.appendChild(c);
        });
        await page.click('#clip-control');
        await page.fill('#clip-control', 'PASTED');
        await page.click('#clip-control');
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('ControlOrMeta+c');
        await page.fill('#clip-control', '');
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(120);
        const ctrl = await page.evaluate(() => document.getElementById('clip-control').value);
        expect(ctrl, 'clipboard instrument must fire on the un-bound control before any arm counts').toBe('PASTED');
        await page.fill('#clip-control', '');

        // the interception must be live on the shimmed field (real focus registers it)
        await page.click('#ref-input');
        await page.waitForFunction(() => {
            const el = document.getElementById('ref-input');
            const ev = new KeyboardEvent('keydown', { key: 'Shift', keyCode: 16, bubbles: true, cancelable: true });
            return el.dispatchEvent(ev) === false;   // false = intercepted
        });
    });

    test('01 - paste lands with no prior typing', async ({ page }) => {
        await page.evaluate(() => { document.getElementById('ref-input').value = ''; });
        await page.click('#ref-input');
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(150);
        const v = await page.evaluate(() => document.getElementById('ref-input').value);
        expect(v, 'Meta+V must insert into the shimmed field').toBe('PASTED');
    });

    test('02 - paste lands after typing, and typing itself stays intercepted (composed once)', async ({ page }) => {
        await page.evaluate(() => { document.getElementById('ref-input').value = ''; });
        await page.click('#ref-input');
        await page.keyboard.type('abc', { delay: 70 });
        await page.waitForTimeout(150);
        const typed = await page.evaluate(() => document.getElementById('ref-input').value);
        expect(typed, 'the interception must still own typing - a doubled value means the native insert leaked').toBe('abc');
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(150);
        const v = await page.evaluate(() => document.getElementById('ref-input').value);
        expect(v, 'paste must append at the caret after typed content').toBe('abcPASTED');
    });

    test('03 - Cmd+A selects the whole value (the chord family, not just paste)', async ({ page }) => {
        await page.evaluate(() => { document.getElementById('ref-input').value = ''; });
        await page.click('#ref-input');
        await page.keyboard.type('xyz', { delay: 70 });
        await page.waitForTimeout(150);
        await page.keyboard.press('ControlOrMeta+a');
        await page.waitForTimeout(100);
        const sel = await page.evaluate(() => {
            const el = document.getElementById('ref-input');
            return { s: el.selectionStart, e: el.selectionEnd, len: el.value.length };
        });
        expect(sel.len).toBe(3);
        expect(sel.s, 'select-all must span from 0').toBe(0);
        expect(sel.e, 'select-all must span to the end').toBe(3);
    });

    test('04 - a paste event is observable again (the pre-fix state dispatched none)', async ({ page }) => {
        await page.evaluate(() => {
            window.__pasteSeen = 0;
            document.getElementById('ref-input')
                .addEventListener('paste', () => { window.__pasteSeen++; }, true);
            document.getElementById('ref-input').value = '';
        });
        await page.click('#ref-input');
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(150);
        const seen = await page.evaluate(() => window.__pasteSeen);
        expect(seen, 'the native paste event must reach the field').toBe(1);
    });
});
