'use strict';

/**
 * Playwright RUNTIME e2e for #B1083 — the payload a form's error callback receives when the server
 * answered (the real built gina bundle, the shared /autocomplete and /hform fixtures, answers fulfilled
 * through `page.route`).
 *
 * The defect: a server error's payload carried no `transportError` key, although the forms guide says
 * it is `false` there, so a check `data.transportError === false` never matched; and nothing said what
 * the answer was, so a reverse proxy's HTML error page, which arrives whole in `message`, looked like a
 * message the application wrote (`{ message, status }` either way), while the success path hands an
 * HTML answer over as `{ contentType, content, status }`. An answer sent as an attachment (the
 * download branch) lost a body that is not JSON altogether (`{ status }`).
 *
 * The fix: every error payload that follows an answer carries `transportError: false` and
 * `contentType` (the answer's `Content-Type` as the browser reads it, `null` when there is none; a JSON
 * body's own key is kept),
 * and the download branch keeps a body that is not JSON in `message`, as the normal case does.
 *
 * The instrument reads the RAW payload (its keys and `in` checks), never a coerced boolean: the #B447
 * hform fixture records `!!d.transportError`, which reads false for a missing key too.
 *
 *   01 a 502 HTML page, `error.<id>`: transportError false, contentType text/html, the page in message (RED)
 *   02 the same through the declared `data-gina-form-event-on-submit-error` handler          (RED)
 *   03 a 422 JSON answer: transportError false, contentType application/json, its message    (RED)
 *   04 a 502 HTML page sent as an attachment (the download branch): the page in message      (RED)
 *   05 a 502 that sends no Content-Type: contentType is what the browser reads for that
 *      answer (null in Chromium), the body in message                                     (RED)
 *   06 a 200 JSON answer that does not parse: the 422 it is reported as carries both keys     (RED)
 *   07 CONTROL a JSON error body with its own contentType key keeps it
 *   08 CONTROL a transport failure: transportError true, status 408
 *   09 CONTROL a 200 HTML answer reaches `success.<id>` as { content, contentType, status }, no
 *      transportError key
 *
 * Pre-fix arm: `GINA_B1083_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle instead of
 * the working-tree dist.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;
const PREFIX_BUNDLE = process.env.GINA_B1083_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1083_PREFIX_BUNDLE) : null;

/** A reverse proxy's error page, as a gateway sends it when the application is unreachable. */
const PROXY_HTML = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n'
    + '<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>proxy</center>\r\n</body>\r\n</html>\r\n';

/**
 * In-page snapshot of a payload: its keys and the values this spec reads, with `in` checks, so a
 * missing key never reads as `false`.
 */
const SNAP_SRC = 'window.__b1083snap = function (d) {'
    + ' if (d === null || typeof d !== "object") { return { kind: d === null ? "null" : typeof d }; }'
    + ' return { keys: Object.keys(d).sort(), hasTransportError: ("transportError" in d), transportError: d.transportError,'
    + ' hasContentType: ("contentType" in d), contentType: d.contentType, status: d.status,'
    + ' message: d.message, hasMessage: ("message" in d), content: d.content, error: d.error };'
    + '};';

/**
 * Serves the pre-fix bundle when asked to, and counts it.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{prefix: number}>}
 */
async function usePrefix(page) {
    const seen = { prefix: 0 };
    if (PREFIX_BUNDLE) {
        await page.route('**/js/gina.min.js*', (r) => { seen.prefix++; return r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    return seen;
}

/**
 * Opens /autocomplete (form `acform`, action /ac-sink) and records `error.acform` / `success.acform`,
 * which bubble to `document` there.
 *
 * @param {import('@playwright/test').Page} page
 * @param {function} answer - the `page.route` handler for /ac-sink
 * @returns {Promise<Array<{name: string, detail: object}>>} the events, after one submit
 */
async function submitAc(page, answer) {
    const seen = await usePrefix(page);
    await page.route('**/ac-sink', answer);
    await page.addInitScript(SNAP_SRC);
    await page.goto(BASE + '/autocomplete');
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms.acform), null, { timeout: 15000 });
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    await page.evaluate(() => {
        window.__evts = [];
        ['error.acform', 'success.acform'].forEach((n) => document.addEventListener(n, (e) => {
            window.__evts.push({ name: n, detail: window.__b1083snap(e && e.detail) });
        }));
    });
    // A Safari user agent keeps an autocomplete="off" field readonly until it is focused (#B996).
    await page.focus('#ref-input');
    await page.fill('#ref-input', 'ABC123');
    await page.waitForTimeout(400);
    await page.click('#acform-submit');
    await page.waitForFunction(() => window.__evts.length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    return page.evaluate(() => window.__evts);
}

/**
 * Opens /hform (form `hformform`, action /hform-sink, a declared submit-error handler) and records the
 * payload that handler receives: the fixture's own handler is wrapped as it is assigned.
 *
 * @param {import('@playwright/test').Page} page
 * @param {function} answer - the `page.route` handler for /hform-sink
 * @returns {Promise<object[]>} one snapshot per call of the declared handler
 */
async function submitHform(page, answer) {
    const seen = await usePrefix(page);
    await page.route('**/hform-sink', answer);
    await page.addInitScript(SNAP_SRC);
    await page.addInitScript(() => {
        window.__declared = [];
        var own = null;
        Object.defineProperty(window, 'onHformSubmitError', {
            configurable: true,
            set: function (fn) { own = fn; },
            get: function () {
                return function (event, data) {
                    window.__declared.push(window.__b1083snap(data));
                    return own ? own.apply(this, arguments) : undefined;
                };
            }
        });
    });
    await page.goto(BASE + '/hform');
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms && window.gina.validator.$forms.hformform), null, { timeout: 15000 });
    if (PREFIX_BUNDLE) { expect(seen.prefix, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    await page.fill('#hform-input', 'ABC123');
    await page.waitForTimeout(400);
    await page.click('#hformform-submit');
    await page.waitForFunction(() => window.__declared.length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    return page.evaluate(() => window.__declared);
}

/** @returns {object} the one `error.acform` payload */
function oneError(evts) {
    const errs = evts.filter((e) => e.name === 'error.acform');
    expect(errs.length, 'the error event fired once').toBe(1);
    return errs[0].detail;
}

/**
 * Asserts the two keys every error payload that follows an answer carries.
 *
 * @param {object} d - a payload snapshot
 * @param {RegExp} contentTypePattern - what its contentType must match
 * @returns {void}
 */
function expectAnswered(d, contentTypePattern) {
    expect(d.hasTransportError, 'the payload carries a transportError key').toBe(true);
    expect(d.transportError, 'the server answered: not a transport failure').toBe(false);
    expect(d.hasContentType, 'the payload carries a contentType key').toBe(true);
    expect(String(d.contentType)).toMatch(contentTypePattern);
}

test.describe('#B1083 validator — the error payload says the server answered, and what it answered', () => {

    test('01 - a 502 HTML page: transportError false, contentType text/html, the page in message (RED pre-fix)', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 502, contentType: 'text/html', body: PROXY_HTML })));
        expect(d.status).toBe(502);
        expectAnswered(d, /^text\/html/);
        expect(d.message, 'the page arrives whole in message, as before').toBe(PROXY_HTML);
    });

    test('02 - the same through the declared submit-error handler (RED pre-fix)', async ({ page }) => {
        const calls = await submitHform(page, (r) => r.fulfill({ status: 502, contentType: 'text/html', body: PROXY_HTML }));
        expect(calls.length, 'the declared handler ran once').toBe(1);
        expect(calls[0].status).toBe(502);
        expectAnswered(calls[0], /^text\/html/);
        expect(calls[0].message).toBe(PROXY_HTML);
    });

    test('03 - a 422 JSON answer: transportError false, contentType application/json (RED pre-fix)', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 422, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ status: 422, message: 'invalid' }) })));
        expect(d.status).toBe(422);
        expectAnswered(d, /^application\/json/);
        expect(d.message, 'the server-written message').toBe('invalid');
    });

    test('04 - a 502 HTML page sent as an attachment (the download branch): the page in message (RED pre-fix)', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 502, headers: { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="report.bin"' }, body: PROXY_HTML })));
        expect(d.status).toBe(502);
        expectAnswered(d, /^text\/html/);
        expect(d.hasMessage, 'the body is kept, not dropped').toBe(true);
        expect(d.message).toBe(PROXY_HTML);
    });

    test('05 - a 502 that sends no Content-Type: contentType is what the browser reads for it, the body in message (RED pre-fix)', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 502, body: 'Bad Gateway' })));
        // The oracle: the same answer read by a plain XHR in the same browser. Chromium reads null;
        // WebKit, under this route's fulfil, reads text/plain (measured 2026-11-03).
        const reported = await page.evaluate(() => new Promise((resolve) => {
            var x = new XMLHttpRequest();
            x.open('POST', '/ac-sink');
            x.onloadend = function () { resolve(x.getResponseHeader('Content-Type')); };
            x.send('{}');
        }));
        console.log('[#B1083 05] the browser reads Content-Type as ' + JSON.stringify(reported));
        expect(d.status).toBe(502);
        expect(d.hasTransportError, 'the payload carries a transportError key').toBe(true);
        expect(d.transportError).toBe(false);
        expect(d.hasContentType, 'the payload carries a contentType key').toBe(true);
        expect(d.contentType, 'what the browser reads for the same answer').toBe(reported);
        expect(d.message).toBe('Bad Gateway');
    });

    test('06 - a 200 JSON answer that does not parse: the 422 it is reported as carries both keys (RED pre-fix)', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"half": ' })));
        expect(d.status, 'a failure to handle the answer is reported as 422').toBe(422);
        expect(typeof d.error, 'the parse error is described').toBe('string');
        expectAnswered(d, /^application\/json/);
    });

    test('07 - CONTROL a JSON error body with its own contentType key keeps it', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ status: 400, error: 'refused type', contentType: 'image/gif' }) })));
        expect(d.status).toBe(400);
        expect(d.contentType, 'the body names the refused type: kept').toBe('image/gif');
    });

    test('08 - CONTROL a transport failure: transportError true, status 408', async ({ page }) => {
        const d = oneError(await submitAc(page, (r) => r.abort('connectionrefused')));
        expect(d.status).toBe(408);
        expect(d.transportError).toBe(true);
    });

    test('09 - CONTROL a 200 HTML answer reaches success.<id> as { content, contentType, status }', async ({ page }) => {
        const evts = await submitAc(page, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>saved</p>' }));
        const ok = evts.filter((e) => e.name === 'success.acform');
        expect(ok.length, 'the success event fired once').toBe(1);
        expect(ok[0].detail.keys).toEqual(['content', 'contentType', 'status']);
        expect(ok[0].detail.content).toBe('<p>saved</p>');
    });
});
