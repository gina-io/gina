'use strict';

/**
 * #B447 — a form submit that fails at the TRANSPORT layer dispatches no event,
 * so a consumer's declared submit-error handler never fires.
 *
 * Reported by a consumer session from source reading of the published artifact;
 * this spec is the runtime verification that report explicitly did NOT have.
 *
 * MECHANISM (verified in source): the xhr.onreadystatechange settle chain has a
 * success arm `/^2/.test(xhr.status)` and an error arm `else if (xhr.status != 0)`
 * which EXCLUDES 0. The arm that would handle status 0 is fully commented out and
 * there is no trailing else, so both `error.<id>` and `error.<id>.hform` — which
 * live inside the status != 0 arm — are unreachable for a transport failure.
 * `xhr.onerror` and `xhr.timeout` are never assigned (measured 0 each, with
 * `ontimeout` = 2 and `responseType` = 3 as firing controls).
 *
 * ARMS. 01 is the POSITIVE CONTROL and must pass on BOTH sides of the fix: a 500
 * response fires the error event, proving the listener is wired where a real
 * consumer handler would sit. Without it, arm 02's "nothing fired" would be
 * indistinguishable from a broken probe. 02 is the defect: the same submit whose
 * request is ABORTED at the transport layer.
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT;

/** Load the validator fixture and wait for positive bind evidence. */
async function gotoForm(page) {
    await page.goto(BASE + '/autocomplete');
    await page.waitForFunction(
        () => window.gina && window.gina.isFrameworkLoaded === true
            && window.gina.validator && window.gina.validator.$forms
            && window.gina.validator.$forms['acform'],
        null,
        { timeout: 15000 }
    );
    // Positive evidence the form is actually bound — never absence-of-error.
    const bound = await page.evaluate(
        () => !!(window.gina.validator.$forms['acform']));
    expect(bound, 'acform must be bound before submitting').toBe(true);
}

/**
 * Record every settle-ish event the validator can dispatch for this form.
 * triggerEvent dispatches bubbling CustomEvents, so document catches them all.
 */
async function installRecorder(page) {
    await page.evaluate(() => {
        window.__evts = [];
        ['error.acform', 'error.acform.hform', 'success.acform', 'submit.acform']
            .forEach((n) => document.addEventListener(n, (e) => {
                window.__evts.push({
                    name: n,
                    status: e && e.detail && e.detail.status,
                    transportError: !!(e && e.detail && e.detail.transportError)
                });
            }));
    });
}

async function submitAndCollect(page) {
    // The field is live-checked and empty fails validation, which blocks the
    // submit client-side — without this the XHR never fires and BOTH arms read
    // "no error event" for the wrong reason (measured: the positive control
    // failed until the field was filled).
    // On a Safari user agent (the webkit project carries one) gina keeps an autocomplete="off"
    // field readonly until it is focused (its autofill workaround), and fill() requires an
    // editable element before it focuses it: focus first, as a user does (#B996).
    await page.focus('#ref-input');
    await page.fill('#ref-input', 'ABC123');
    await page.waitForTimeout(400);
    await page.click('#acform-submit');
    await page.waitForTimeout(2500);
    return page.evaluate(() => window.__evts);
}

test.describe('#B447 validator — transport-layer submit failure must reach the consumer', () => {

    test('01 - POSITIVE CONTROL: a 500 response DOES fire the error event', async ({ page }) => {
        await page.route('**/ac-sink', (route) => route.fulfill({
            status: 500,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ status: 500, message: 'boom' })
        }));
        await gotoForm(page);
        await installRecorder(page);
        const evts = await submitAndCollect(page);
        const errs = evts.filter((e) => /^error\./.test(e.name));
        expect(errs.length,
            'the listener must be wired where a real consumer handler sits — '
            + 'if this is 0 the probe is broken and arm 02 proves nothing'
        ).toBeGreaterThan(0);
        expect(errs[0].status).toBe(500);
    });

    test('02 - a transport failure reaches the consumer (RED pre-fix)', async ({ page }) => {
        await page.route('**/ac-sink', (route) => route.abort('connectionrefused'));
        await gotoForm(page);
        await installRecorder(page);
        const evts = await submitAndCollect(page);
        console.log('[#B447] events observed on transport failure:', JSON.stringify(evts));
        const errs = evts.filter((e) => /^error\./.test(e.name));
        // RED PRE-FIX: this was 0 — the submit settled silently.
        expect(errs.length, 'a transport failure must reach the consumer').toBeGreaterThan(0);
        // 408 keeps `status >= 400` handlers working; transportError distinguishes
        // this from a genuine timeout, which emits a bare 408.
        expect(errs[0].status, 'status must be 408').toBe(408);
        expect(errs[0].transportError,
            'transportError distinguishes this from a genuine timeout').toBe(true);
        // The `error.<id>.hform` channel is NOT asserted on THIS fixture — it is
        // shared with the autocomplete specs, and declaring
        // `data-gina-form-event-on-submit-error` here would flip hFormIsRequired
        // and change their scene. It is asserted in describe-block 03 below,
        // against its own /hform fixture.
    });
});

/**
 * #B447 — the `error.<id>.hform` channel.
 *
 * WHY THIS EXISTS. A consumer session reviewing the fix made a fair point: the
 * `.hform` emit is unconditional in the same arm as `error.<id>`, so the code path
 * is shared — but "shared path" is not a pin. Nothing went red if a refactor
 * dropped the second emit, and `.hform` is the channel
 * `data-gina-form-event-on-submit-error` actually registers, i.e. the one a real
 * consumer's declared handler receives. So it gets its own assertion, on its own
 * fixture (declaring the attribute on the shared /autocomplete page would flip
 * hFormIsRequired and change the autocomplete-caret specs' scene).
 *
 * Arm 01 is the POSITIVE CONTROL and must pass on both sides of the fix.
 */
test.describe('#B447 validator — the hform channel reaches a DECLARED handler', () => {

    // ⚠️ MEASURED TRAP, do not "fix" this back to a document listener.
    // An earlier revision of these arms asserted `error.<id>.hform` on a
    // document-level addEventListener. That assertion CANNOT PASS by
    // construction: utils/events.js `on()` rewrites 'error.hform' to
    // 'error.<id>.hform' (so listener and emit DO match), but `addListener`
    // wraps every handler in `cancelEvent(e)` — which stops propagation before
    // the event reaches `document`. The base `error.<id>` bubbles only because
    // nothing registered a gina listener for it in this fixture. So a
    // document-level probe reports the hform channel as dead whether it works
    // or not — an assertion that cannot succeed is as useless as a control that
    // cannot fail. The DECLARED handler is both the real consumer contract and
    // the only honest observation point.

    async function gotoHform(page) {
        await page.goto(BASE + '/hform');
        await page.waitForFunction(
            () => window.gina && window.gina.isFrameworkLoaded === true
                && window.gina.validator && window.gina.validator.$forms
                && window.gina.validator.$forms['hformform'],
            null,
            { timeout: 15000 }
        );
        const bound = await page.evaluate(
            () => !!(window.gina.validator.$forms['hformform']));
        expect(bound, 'hformform must be bound before submitting').toBe(true);
    }

    async function submitAndCollect(page) {
        // Empty fails isRequired and blocks the submit client-side, so the XHR
        // would never fire and both arms would read "nothing" for the wrong reason.
        await page.fill('#hform-input', 'ABC123');
        await page.waitForTimeout(400);
        await page.click('#hformform-submit');
        await page.waitForTimeout(2500);
        return page.evaluate(() => window.__hformCalls);
    }

    test('01 - POSITIVE CONTROL: a 500 reaches the DECLARED handler', async ({ page }) => {
        await page.route('**/hform-sink', (route) => route.fulfill({
            status: 500,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ status: 500, message: 'boom' })
        }));
        await gotoHform(page);
        const declared = await submitAndCollect(page);
        console.log('[#B447/hform 500] declared:', JSON.stringify(declared));
        // Without this, arm 02 proving "the handler ran" would not distinguish a
        // working hform channel from a fixture that registers handlers for anything.
        expect(declared.length,
            'the declared data-gina-form-event-on-submit-error handler must run on a 500 — '
            + 'if this is 0 the fixture is broken and arm 02 proves nothing'
        ).toBeGreaterThan(0);
        expect(declared[declared.length - 1].status, 'status must be 500').toBe(500);
        expect(declared[declared.length - 1].transportError,
            'a genuine HTTP error must NOT be flagged as a transport failure').toBe(false);
    });

    test('02 - a TRANSPORT failure reaches the DECLARED handler (RED pre-fix)', async ({ page }) => {
        await page.route('**/hform-sink', (route) => route.abort('connectionrefused'));
        await gotoHform(page);
        const declared = await submitAndCollect(page);
        console.log('[#B447/hform transport] declared:', JSON.stringify(declared));
        // RED PRE-FIX: zero — the transport arm emitted nothing, so the declared
        // handler was never invoked. This is the exact gap a consumer reported.
        expect(declared.length,
            'a transport failure must reach the declared submit-error handler'
        ).toBeGreaterThan(0);
        expect(declared[declared.length - 1].status, 'status must be 408').toBe(408);
        expect(declared[declared.length - 1].transportError,
            'transportError distinguishes this from a genuine timeout').toBe(true);
    });
});
