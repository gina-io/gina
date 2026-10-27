'use strict';

/**
 * Playwright RUNTIME e2e for #B319 — the refused-submit answer must stay VISIBLE
 * after the framework focuses the first invalid field (the real built gina
 * bundle, real focus events, a real click).
 *
 * The defect: both refused-submit answers render the error message and then
 * focus the first invalid field — `revealValidationState` (the gated-trigger
 * reveal, #B246/#B308) via `focusFirstInvalidField`, and the `validate.<id>`
 * handler (an enabled trigger's refused submit) via its inline focus twin.
 * `.focus()` synchronously dispatches native `focusin`, which routes through
 * `focusinProxyHandler` into the live-check listener's focusin arm, whose
 * `refreshWarning` call sees the field is now `document.activeElement` and
 * flips `form-item-error` -> `form-item-warning`, hiding + clipping the very
 * message the answer just rendered. The framework suppresses its own answer:
 * a refused submit explains itself only to a screen reader (#A11Y5 keeps the
 * clipped node resolvable) while sighted users see nothing.
 *
 * The fix: a one-shot answer-focus exemption — both submit-focus sites raise a
 * module flag around their focus loop, and the focusin arm skips the
 * `refreshWarning` downgrade for exactly that synchronous dispatch. The first
 * later keystroke re-engages the deliberate mid-typing suppression untouched
 * (arm 04 locks that).
 *
 * WHY THIS LIVES IN test/e2e: the defect spans a real focus dispatch driving a
 * real event listener inside the COMMITTED minified bundle — jsdom cannot serve
 * the built artifact, and a unit replica of the focus choreography could not
 * lose the race it exists to measure. The suppression is synchronous inside
 * `.focus()`, which is also why an async `query` rule is incidental — arm 02
 * proves the same defect and the same fix across a real query round trip.
 *
 * Arms (each a control for the others):
 *   01 SYNC rules, gated-trigger click        -> message stays visible (RED before the fix)
 *   02 ASYNC query rule, same scene           -> ditto across a round trip (RED before the fix)
 *   03 enabled path: untrusted $forms.submit()-> the validate.<id> inline twin
 *                                                (skips the #B308 trusted-gesture
 *                                                gate by design)                (RED before the fix)
 *   04 typing after the answer                -> suppression re-engages (the
 *                                                subtract control: proves the
 *                                                exemption is one-shot and the
 *                                                mid-typing UX survives)
 */

const { test, expect } = require('@playwright/test');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

/** The rules literal the /face harness ships, URL-encoded into gina.onload.face.js. */
const STOCK_RULES = '{"rules":{"faceform":{"agree":{"isRequired":true}}}}';

/** Stock + a second field that fails a SYNC rule (length floor far above the input). */
const SYNC_RULES = JSON.stringify({
    rules: {
        faceform: {
            agree: { isRequired: true },
            note: { isRequired: true, isString: [50, 90] }
        }
    }
});

/** Stock + a second field whose LAST rule is an async `query` that stays invalid. */
const ASYNC_RULES = JSON.stringify({
    rules: {
        faceform: {
            agree: { isRequired: true },
            // `validIf: true` vs a `{"isValid":false}` body => the field stays invalid.
            note: { isRequired: true, query: { url: '/uniq', method: 'GET', validIf: true } }
        }
    }
});

/**
 * Swap the harness's form rules and stub the uniqueness endpoint.
 * `rulesRewritten` is the extraction control — if the STOCK_RULES anchor ever
 * drifts it reads false and the scene is inconclusive rather than silently
 * running the stock single-field rules.
 */
async function installRules(page, rulesJson, queryBody) {
    const seen = { rulesRewritten: null, queryCalls: 0 };
    await page.route('**/js/gina.onload.face.js', async (route) => {
        const body = await (await route.fetch()).text();
        const from = encodeURIComponent(STOCK_RULES);
        seen.rulesRewritten = body.indexOf(from) > -1;
        await route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: seen.rulesRewritten ? body.split(from).join(encodeURIComponent(rulesJson)) : body
        });
    });
    await page.route('**/uniq*', async (route) => {
        seen.queryCalls++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: queryBody || '{"isValid":false}' });
    });
    return seen;
}

async function gotoFaceAndBoot(page) {
    await page.goto(BASE + 'face');
    await page.waitForFunction(() => !!customElements.get('x-agree'), null, { timeout: 15000 });
    await page.waitForFunction(() => !!(
        window.gina && window.gina.isFrameworkLoaded === true
        && window.gina.validator && window.gina.validator.$forms
        && window.gina.validator.$forms['parent']
    ), null, { timeout: 15000 });
}

/**
 * Class-AGNOSTIC read of the `note` field's message wrapper + parent state.
 * The suppression flips the parent class AND hides the wrapper, so a probe
 * keyed on the error class would read a clipped node as "gone" — this one
 * reports existence, class, geometry and text separately (the instrument
 * lesson from the #B319 filing).
 */
function readState(page) {
    return page.evaluate(() => {
        const $note   = document.getElementById('note');
        const $parent = $note ? $note.parentNode : null;
        const $msg = $parent
            ? Array.prototype.find.call(
                $parent.getElementsByTagName('div'),
                (d) => /form-item-error-message/.test(d.className))
            : null;
        return {
            parentClass : $parent ? $parent.className : null,
            found       : !!$msg,
            msgClass    : $msg ? $msg.className : null,
            height      : $msg ? $msg.getBoundingClientRect().height : null,
            text        : $msg ? ($msg.textContent || '').trim().slice(0, 60) : null,
            ariaInvalid : $note ? $note.getAttribute('aria-invalid') : null,
            errMsgResolvable: !!($note && $note.getAttribute('aria-errormessage')
                && document.getElementById($note.getAttribute('aria-errormessage'))),
            activeEl    : document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
            // stuck-true control: a selector that must never match
            bogus       : !!($parent && Array.prototype.find.call(
                              $parent.getElementsByTagName('div'),
                              (d) => /zzz-bogus-never/.test(d.className)))
        };
    });
}

/**
 * Engage the FACE, make `note` invalid, blur to commit the error, and wait for
 * the committed message to be VISIBLE — the positive control every arm needs
 * before it acts (a later "hidden" is then a real state change, not a bad
 * selector or an uncommitted error).
 */
async function sceneWithCommittedError(page, seen) {
    await gotoFaceAndBoot(page);
    expect(seen.rulesRewritten, 'rule swap anchor drifted — scene inconclusive').toBe(true);

    await page.click('#parent x-agree button');           // satisfy `agree`
    await page.click('#note');
    await page.keyboard.type('nope', { delay: 20 });
    // Blur -> commit the error, by a click on the page: #note is the page's last
    // focusable element, and a Tab past it left the focus on the field in
    // Playwright's Firefox, so the error was never committed there.
    await page.mouse.click(5, 5);

    await expect.poll(async () => {
        const s = await readState(page);
        return s.found && s.height > 1 && /form-item-error/.test(s.parentClass || '');
    }, { timeout: 8000 }).toBe(true);

    const before = await readState(page);
    expect(before.bogus, 'CONTROL FAILED: bogus selector matched (stuck true)').toBe(false);
    return before;
}

/** The shared post-answer assertion: focus landed AND the message survived it. */
async function expectAnswerVisible(page) {
    // The focus move is the LAST step of the answer on both paths — poll it,
    // then read the steady state it left behind.
    await expect.poll(async () => (await readState(page)).activeEl, { timeout: 8000 }).toBe('note');

    const after = await readState(page);
    expect(after.found, 'message wrapper gone from the DOM').toBe(true);
    expect(after.height, 'message clipped/hidden after the answer focus').toBeGreaterThan(1);
    expect(after.msgClass).not.toMatch(/hidden/);
    expect(after.parentClass).toMatch(/form-item-error/);
    expect(after.parentClass).not.toMatch(/form-item-warning/);
    // #A11Y5 invariants survive the fix: committed error stays asserted and resolvable.
    expect(after.ariaInvalid).toBe('true');
    expect(after.errMsgResolvable).toBe(true);

    // Steady state, not a transient: nothing re-hides it after the answer settles.
    await page.waitForTimeout(800);
    const settled = await readState(page);
    expect(settled.height, 'message re-hidden after the answer settled').toBeGreaterThan(1);
    return settled;
}

test.describe('#B319 — the refused-submit answer stays visible after its own focus move', function () {

    test('01 SYNC rules: gated-trigger click reveal keeps the message visible', async ({ page }) => {
        const seen = await installRules(page, SYNC_RULES, null);
        await sceneWithCommittedError(page, seen);

        await page.click('#parent-submit', { force: true });
        await expectAnswerVisible(page);
    });

    test('02 ASYNC query rule: same answer, same visibility across a round trip', async ({ page }) => {
        const seen = await installRules(page, ASYNC_RULES, '{"isValid":false}');
        await sceneWithCommittedError(page, seen);
        expect(seen.queryCalls, 'query stub never exercised — scene inconclusive').toBeGreaterThan(0);

        await page.click('#parent-submit', { force: true });
        await expectAnswerVisible(page);
    });

    test('03 enabled path: an untrusted programmatic submit drives the validate.<id> twin', async ({ page }) => {
        const seen = await installRules(page, SYNC_RULES, null);
        await sceneWithCommittedError(page, seen);

        // $forms[id].submit() arrives UNTRUSTED (triggerEvent CustomEvent), so it
        // deliberately skips the #B308 trusted-gesture gate and runs the fresh
        // validate -> refused -> validate.<id> handler -> inline focus twin.
        await page.evaluate(() => window.gina.validator.$forms['parent'].submit());
        await expectAnswerVisible(page);
    });

    test('04 typing after the answer re-engages the mid-typing suppression (subtract control)', async ({ page }) => {
        const seen = await installRules(page, SYNC_RULES, null);
        await sceneWithCommittedError(page, seen);

        await page.click('#parent-submit', { force: true });
        // Reaching the answered state first matters: this arm proves the
        // exemption is ONE-SHOT, so it must start from the VISIBLE state the
        // fix produces — asserted here so the later hide is a real transition
        // (pre-fix the message is already hidden at this point and the arm
        // would measure nothing).
        await expect.poll(async () => (await readState(page)).activeEl, { timeout: 8000 }).toBe('note');
        expect((await readState(page)).height).toBeGreaterThan(1);

        await page.keyboard.type('x', { delay: 20 });
        // The live-check keyup debounce is 1s; the passes it triggers hide the
        // actively-edited field's message again (still failing isString[50,90]).
        // Deliberately NOT asserted: the border class. In this configuration
        // the answer focus re-registered the same field, so `lastFocused` reads
        // [note, note] and handleErrorsDisplay's isWarning heuristic keeps the
        // hard error border while the `:1395` active-element ternary hides the
        // message — the hidden message IS the mid-typing contract; the border
        // choice there is lastFocused-heuristic behaviour outside #B319.
        await expect.poll(async () => {
            const s = await readState(page);
            return s.found && ( /hidden/.test(s.msgClass || '') || s.height <= 1 );
        }, { timeout: 8000 }).toBe(true);

        const suppressed = await readState(page);
        // #A11Y5 survives the re-hide: still asserted, still resolvable (clipped, not removed).
        expect(suppressed.ariaInvalid).toBe('true');
        expect(suppressed.errMsgResolvable).toBe(true);
    });

});
