'use strict';

/**
 * #B727 (gh#83 part 4) — the staged-upload error slot must render a server error message as
 * TEXT, never HTML. A non-2xx, non-JSON staging response is kept verbatim as `result.message`
 * and was written `$error.innerHTML = '<p>'+errMsg+'</p>'`, so a proxy/WAF HTML error page — or
 * a reflected upload filename — rendered as live markup. The fix builds the <p> with
 * createElement + textContent.
 *
 * Drives the real built bundle via the existing /upload-preview fixture (form `b459form`,
 * input #docA, error slot #docA-error), overriding /upload-stage with page.route.
 *
 * RED-FIRST: against the pre-fix bundle the injected <i> IS a real element (measured
 * 2026-10-01 on the published 0.7.1 dist); this spec asserts it is NOT, so it is red
 * before the fix and green after the rebuild.
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.describe('#B727 — the upload error slot renders a server error as text, not HTML', () => {

    test('a non-JSON error body is escaped: no injected element, the markup shows as literal text', async ({ page }) => {
        // a server/proxy error body carrying markup; a passive element stands in for an active
        // payload (<img onerror>, <svg onload>) that would execute the same way.
        const INJECT = '<i id="b727xss" data-injected="1">INJECTED</i> boom';
        await page.route('**/upload-stage', (route) =>
            route.fulfill({ status: 400, contentType: 'text/plain; charset=utf-8', body: INJECT }));
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

        await page.goto(BASE + 'upload-preview');
        await page.waitForFunction(() => !!(
            window.gina && window.gina.isFrameworkLoaded === true
            && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']
        ), null, { timeout: 15000 });

        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForFunction(() => {
            const el = document.getElementById('docA-error');
            return !!(el && el.textContent && el.textContent.indexOf('INJECTED') > -1);
        }, null, { timeout: 10000 });

        const probe = await page.evaluate(() => {
            const slot = document.getElementById('docA-error');
            return {
                injectedExists: !!document.getElementById('b727xss'),
                childTagNames: slot ? Array.prototype.map.call(slot.children, (c) => c.tagName) : null,
                text: slot ? slot.textContent : null
            };
        });

        // the fix: the markup never became a node, and its characters survive as literal text
        expect(probe.injectedExists, 'the <i> markup must NOT become a DOM element').toBe(false);
        expect(probe.text, 'the raw markup is shown as literal text').toContain('<i id="b727xss"');
        // the only element in the slot is the framework's own <p> wrapper
        expect(probe.childTagNames).toEqual(['P']);
        expect(pageErrors).toEqual([]);
    });

    test('CONTROL — a plain-text error body renders unchanged (the <p> wrapper, the text)', async ({ page }) => {
        await page.route('**/upload-stage', (route) =>
            route.fulfill({ status: 400, contentType: 'text/plain; charset=utf-8', body: 'file too large' }));
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

        await page.goto(BASE + 'upload-preview');
        await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms['b459form']), null, { timeout: 15000 });
        await page.setInputFiles('#docA', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await page.waitForFunction(() => {
            const el = document.getElementById('docA-error');
            return !!(el && el.textContent && el.textContent.indexOf('file too large') > -1);
        }, null, { timeout: 10000 });

        const probe = await page.evaluate(() => {
            const slot = document.getElementById('docA-error');
            return { text: slot.textContent.trim(), childTagNames: Array.prototype.map.call(slot.children, (c) => c.tagName) };
        });
        expect(probe.text).toBe('file too large');
        expect(probe.childTagNames).toEqual(['P']);
        expect(pageErrors).toEqual([]);
    });
});
