'use strict';

/**
 * Playwright RUNTIME e2e for the validator fix #B1039 (the real built gina bundle, real forms, real
 * keystrokes and clicks).
 *
 * A clean `query` verdict starts a re-validation of the form. The `query` arm never removed its field
 * from that pass's input, and #B230 keeps a `_case_` driver in it whatever its rules, so the nested pass
 * asked again and its clean verdict started the same pass. With a value, answered from the verdict cache
 * by a microtask, the tab froze; with an empty value, which is never cached, requests streamed. The
 * nested pass now carries the fields whose verdict is in (`cb.judgedQueries`) and does not ask them
 * again. The field and its value stay in the pass, because a `_case_` driver's value is read there.
 *
 * With a breaker on `queueMicrotask`, so a runaway ends and can be read:
 *   01 #B1039 — `query` is a field's only rule, the field not last: typing          (RED: runaway)
 *   02 #B1039 — the same field, last in the rule set                                (RED: runaway)
 *   03 #B1039 — the same field, alone in the rule set                               (RED: runaway)
 *   04 #B1039 — two such fields                                                     (RED: runaway)
 *   05 #B1039 — the sibling that completes the form is typed into                   (RED: runaway)
 *   06 #B1039 — an empty field, alone in the rule set                               (RED: request stream)
 *   07 #B1039 — an empty field, not last                                            (RED: runaway)
 *   08 #B1039 — an empty field, last                                                (RED: request stream)
 *   09 #B1039 — the field also drives a `_case_` block                              (RED: runaway)
 *   10 #B1039 — a sync rule beside `query`, on a field that drives a `_case_` block (RED: runaway)
 *   11 #B1039 — a submit on the valid form posts once                               (RED: runaway)
 *   12 #B1039 — two such fields, then a submit that posts once                      (RED: runaway)
 *   13 #B1039 — a ticked checkbox whose `case` does not match, on a `query` field   (RED: runaway)
 * With no breaker, so a runaway freezes the tab, read through a hard timeout:
 *   14–17 #B1039 — not last / alone / two such fields / drives a `_case_` block     (RED: frozen)
 * Controls, which pass on the pre-fix bundle too:
 *   18–19 a sync rule before, then after `query`
 *   20 an empty required sibling keeps the submit control gated
 *   21 a refused verdict gates and paints   22 a refused submit posts nothing and paints
 *   23 the case a text driver picks still applies
 *   24 a radio group driving a `_case_` block carries `query`: the CHECKED radio picks the case. Taking
 *      the field out of the nested pass fails here: its value then reads the group's first radio, and
 *      the submit control opens on an invalid form
 *   25 the same with a sync rule beside `query`   26 the same beside another `query` field
 *   27 a select driving a `_case_` block
 *   28 a second `query` refuses: gated and painted   29 then a submit posts nothing
 *   30 the breaker itself fires on a chain of microtasks
 *
 * Scene: inline pages served by the runtime server (`/x76-page?b64=`); the whisper is the built onload of
 * /js/gina.onload.b884.js with its rule set replaced per scene; submits go to /ac-sink, which answers {}.
 *
 * Pre-fix arm: `GINA_B1039_PREFIX_BUNDLE=<path to a pre-fix gina.min.js>` serves that bundle to the page
 * instead of the working-tree dist (the RED arms fail there, the controls pass).
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');

const PORT = process.env.GINA_E2E_PORT || '3179';
const BASE = 'http://localhost:' + PORT + '/';

// The subtract arm: the pre-fix bundle to serve, and a hit counter proving it was served.
const PREFIX_BUNDLE = process.env.GINA_B1039_PREFIX_BUNDLE ? fs.readFileSync(process.env.GINA_B1039_PREFIX_BUNDLE) : null;

// Same polling kicker as the other x76-page specs: runs onGinaLoaded once the framework is there.
const KICKER = '(function(){var t=0;function k(){try{if(window.gina&&window.gina.config'
    + '&&typeof window.onGinaLoaded===\'function\'&&!window.gina.isFrameworkLoaded){'
    + 'window.onGinaLoaded(window.gina);}}catch(e){}if((!window.gina||!window.gina.isFrameworkLoaded)'
    + '&&t++<100){setTimeout(k,50);}}k();}());';

const SETTLE = 800;     // past the bind's own pass
const KEYUP = 1400;     // past the 1000 ms keyup timer
const SUBMIT = 900;     // past a submit's own pass and its send
const HARD = 6000;      // a tab that answers nothing in this time is frozen
const BREAKER = 3000;   // queueMicrotask calls a scene may make before the breaker stops forwarding them
const REQUESTS = 4;     // every scene settles on 3 requests or fewer; a stream reaches hundreds

const QUERY = { url: '/b1039-uniq', method: 'GET', validIf: true };
const SECOND_QUERY = { url: '/b1039-uniq2', method: 'GET', validIf: true };

/** A text control, seeded with `value`. */
function text(name, value) {
    return '<div><input id="' + name + '" type="text" name="' + name + '" value="' + value + '"></div>';
}

/** One radio of a group. */
function radio(name, value, checked) {
    return '<div><input id="' + name + '-' + value + '" type="radio" name="' + name + '" value="' + value + '"'
        + (checked ? ' checked' : '') + '></div>';
}

/** The `_case_` block of a driver: `other` is required while the driver holds `value`. */
function requiresOtherWhen(value) {
    return { conditions: [{ case: value, rules: { other: { isRequired: true } } }] };
}

/** A radio group of two, `a` checked, driving `other`'s rules: picking `b` makes `other` required. */
const GROUP = radio('choice', 'a', true) + radio('choice', 'b', false) + text('other', '');

/**
 * The scenes. `expected.gated` is the submit control's `data-gina-form-submit-gated` once the form has
 * settled, `expected.painted` the fields showing an error, `expected.posts` the submits that left.
 */
const SCENES = {
    '01 #B1039 — `query` is a field\'s only rule, the field not last: typing': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '02 #B1039 — the same field, last in the rule set': {
        rules: { other: { isRequired: true }, lookup: { query: QUERY } },
        body: text('other', 'seed') + text('lookup', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '03 #B1039 — the same field, alone in the rule set': {
        rules: { lookup: { query: QUERY } },
        body: text('lookup', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '04 #B1039 — two such fields': {
        rules: { lookup: { query: QUERY }, lookup2: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('lookup2', 'seed2') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '05 #B1039 — the sibling that completes the form is typed into': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', ''),
        type: '#other',
        gatedBefore: 'true',
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '06 #B1039 — an empty field, alone in the rule set': {
        rules: { lookup: { query: QUERY } },
        body: text('lookup', ''),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '07 #B1039 — an empty field, not last': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', '') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '08 #B1039 — an empty field, last': {
        rules: { other: { isRequired: true }, lookup: { query: QUERY } },
        body: text('other', 'seed') + text('lookup', ''),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '09 #B1039 — the field also drives a `_case_` block': {
        rules: { lookup: { query: QUERY }, _case_lookup: requiresOtherWhen('seedx'), other: { isString: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '10 #B1039 — a sync rule beside `query`, on a field that drives a `_case_` block': {
        rules: { lookup: { isRequired: true, query: QUERY }, _case_lookup: requiresOtherWhen('seedx'), other: { isString: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '11 #B1039 — a submit on the valid form posts once': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', '') + text('other', 'seed'),
        submit: true,
        expected: { gated: null, painted: 0, posts: 1 }
    },
    '12 #B1039 — two such fields, then a submit that posts once': {
        rules: { lookup: { query: QUERY }, lookup2: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', '') + text('lookup2', 'seed2') + text('other', 'seed'),
        submit: true,
        expected: { gated: null, painted: 0, posts: 1 }
    },
    '13 #B1039 — a ticked checkbox whose `case` does not match, on a `query` field': {
        rules: { optin: { query: QUERY }, _case_optin: requiresOtherWhen(true), other: { isString: true } },
        body: '<div><input id="optin" type="checkbox" name="optin" value="yes"></div>' + text('other', ''),
        click: '#optin',
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '18 CONTROL — a sync rule before `query`': {
        rules: { lookup: { isRequired: true, query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '19 CONTROL — a sync rule after `query`': {
        rules: { lookup: { query: QUERY, isRequired: true }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        expected: { gated: null, painted: 0, posts: 0 }
    },
    '20 CONTROL — an empty required sibling keeps the submit control gated': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', ''),
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '21 CONTROL — a refused verdict gates and paints': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('other', 'seed'),
        refused: 'all',
        expected: { gated: 'true', painted: 1, posts: 0 }
    },
    '22 CONTROL — a refused submit posts nothing and paints': {
        rules: { lookup: { query: QUERY }, other: { isRequired: true } },
        body: text('lookup', '') + text('other', 'seed'),
        refused: 'all',
        submit: true,
        expected: { gated: 'true', painted: 1, posts: 0 }
    },
    '23 CONTROL — the case a text driver picks still applies': {
        rules: { lookup: { query: QUERY }, _case_lookup: requiresOtherWhen('seedx') },
        body: text('lookup', 'seed') + text('other', ''),
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '24 CONTROL — a radio group driving a `_case_` block carries `query`: the checked radio picks the case': {
        rules: { choice: { query: QUERY }, _case_choice: requiresOtherWhen('b'), other: { isString: true } },
        body: GROUP,
        click: '#choice-b',
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '25 CONTROL — the same with a sync rule beside `query`': {
        rules: { choice: { isRequired: true, query: QUERY }, _case_choice: requiresOtherWhen('b'), other: { isString: true } },
        body: GROUP,
        click: '#choice-b',
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '26 CONTROL — the same beside another `query` field': {
        rules: { choice: { query: QUERY }, lookup: { query: QUERY }, _case_choice: requiresOtherWhen('b'), other: { isString: true } },
        body: radio('choice', 'a', true) + radio('choice', 'b', false) + text('lookup', 'seed') + text('other', ''),
        click: '#choice-b',
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '27 CONTROL — a select driving a `_case_` block': {
        rules: { plan: { query: QUERY }, _case_plan: requiresOtherWhen('b'), other: { isString: true } },
        body: '<div><select id="plan" name="plan"><option value="a" selected>a</option><option value="b">b</option></select></div>'
            + text('other', ''),
        select: ['#plan', 'b'],
        expected: { gated: 'true', painted: 0, posts: 0 }
    },
    '28 CONTROL — a second `query` refuses: gated and painted': {
        rules: { lookup: { query: QUERY }, lookup2: { query: SECOND_QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('lookup2', 'seed2') + text('other', 'seed'),
        refused: 'second',
        expected: { gated: 'true', painted: 1, posts: 0 }
    },
    '29 CONTROL — a second `query` refuses, then a submit posts nothing': {
        rules: { lookup: { query: QUERY }, lookup2: { query: SECOND_QUERY }, other: { isRequired: true } },
        body: text('lookup', 'seed') + text('lookup2', 'seed2') + text('other', 'seed'),
        refused: 'second',
        submit: true,
        expected: { gated: 'true', painted: 1, posts: 0 }
    }
};

// With no breaker a runaway freezes the tab. Each names the breaker scene it repeats.
const NO_BREAKER = {
    '14 #B1039 — no breaker: not last': '01 #B1039 — `query` is a field\'s only rule, the field not last: typing',
    '15 #B1039 — no breaker: alone in the rule set': '03 #B1039 — the same field, alone in the rule set',
    '16 #B1039 — no breaker: two such fields': '04 #B1039 — two such fields',
    '17 #B1039 — no breaker: drives a `_case_` block': '09 #B1039 — the field also drives a `_case_` block'
};

/**
 * Opens the scene's form and waits for it to be bound.
 *
 * @param {object} page
 * @param {object} scene
 * @param {boolean} withBreaker - stop forwarding `queueMicrotask` past BREAKER calls
 * @returns {Promise<{requests: number, posts: number, errors: Array<string>}>} live counters
 */
async function open(page, scene, withBreaker) {
    const run = { requests: 0, posts: 0, errors: [] };
    let hits = null;
    if (PREFIX_BUNDLE) {
        hits = { n: 0 };
        await page.route('**/js/gina.min.js', (r) => { hits.n++; r.fulfill({ status: 200, contentType: 'application/javascript', body: PREFIX_BUNDLE }); });
    }
    page.on('pageerror', (e) => { run.errors.push(String(e && e.message)); });
    page.on('request', (r) => { if (r.url().indexOf('/ac-sink') > -1 && r.method() === 'POST') { run.posts++; } });
    await page.route('**/b1039-uniq*', async (route) => {
        run.requests++;
        const isRefused = scene.refused === 'all' || (scene.refused === 'second' && route.request().url().indexOf('/b1039-uniq2') > -1);
        await new Promise((r) => setTimeout(r, 50));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isValid: !isRefused }) }).catch(() => {});
    });
    await page.route('**/js/gina.onload.b1039.js', async (route) => {
        const response = await route.fetch({ url: BASE + 'js/gina.onload.b884.js' });
        const source = await response.text();
        const whisper = source.match(/%7B%22rules%22%3A[A-Za-z0-9%\-_.~!*()]*/);
        expect(whisper, 'the whisper of the built onload').not.toBeNull();
        const encoded = encodeURIComponent(JSON.stringify({ rules: { b1039: scene.rules } }));
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: source.replace(whisper[0], () => encoded) });
    });
    if (withBreaker) {
        await page.addInitScript((limit) => {
            const forward = window.queueMicrotask.bind(window);
            window.__b1039 = { calls: 0, tripped: 0 };
            window.queueMicrotask = function (fn) {
                window.__b1039.calls++;
                if (window.__b1039.calls > limit) { window.__b1039.tripped++; return; }
                forward(fn);
            };
        }, BREAKER);
    }
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>b1039</title><link rel="icon" href="data:,">'
        + '<link rel="stylesheet" href="/css/vendor/gina/gina.min.css">'
        + '<script src="/js/gina.onload.b1039.js"></script><script src="/js/gina.min.js"></script>'
        + '<script>' + KICKER + '</script></head><body>'
        + '<form id="b1039" data-gina-form-rule="b1039" action="/ac-sink" method="post">' + scene.body
        + '<button id="b1039-submit" type="submit">Save</button></form></body></html>';
    await page.goto(BASE + 'x76-page?b64=' + Buffer.from(html).toString('base64url'));
    await page.waitForFunction(() => !!(window.gina && window.gina.isFrameworkLoaded === true && window.gina.validator
        && window.gina.validator.$forms && window.gina.validator.$forms.b1039 && window.gina.validator.$forms.b1039.binded), null, { timeout: 12000 });
    if (hits) { expect(hits.n, 'the pre-fix bundle was served').toBeGreaterThan(0); }
    await page.waitForTimeout(SETTLE);
    return run;
}

/** Whether the tab still answers, within the hard timeout. */
function answers(page) {
    return Promise.race([
        page.evaluate(() => 'alive').catch(() => 'error'),
        new Promise((r) => setTimeout(() => r('FROZEN'), HARD))
    ]);
}

/** What the form shows. */
function state(page) {
    return page.evaluate(() => ({
        gated: document.getElementById('b1039-submit').getAttribute('data-gina-form-submit-gated'),
        isValidating: window.gina.validator.$forms.b1039.isValidating,
        painted: document.querySelectorAll('.form-item-error,.form-item-warning').length,
        tripped: window.__b1039 ? window.__b1039.tripped : 0
    }));
}

/** The scene's gesture, then the wait past its timers. */
async function act(page, scene) {
    if (scene.click) {
        await page.locator(scene.click).click({ timeout: HARD });
    } else if (scene.select) {
        await page.locator(scene.select[0]).selectOption(scene.select[1], { timeout: HARD });
    } else {
        const target = scene.type || '#lookup';
        await page.locator(target).click({ timeout: HARD });
        await page.locator(target).pressSequentially('x', { delay: 5, timeout: HARD });
    }
    await page.waitForTimeout(KEYUP);
}

/** No runaway: the tab answers, the microtasks stayed under the breaker, the requests stopped. */
async function expectNoRunaway(page, run) {
    expect(await answers(page), 'the tab still answers').toBe('alive');
    expect((await state(page)).tripped, 'no chain of microtasks without end').toBe(0);
    expect(run.requests, 'no stream of requests').toBeLessThanOrEqual(REQUESTS);
    await expect.poll(async () => (await state(page)).isValidating, { message: 'the pass ended', timeout: 5000 }).not.toBe(true);
}

test.describe('#B1039 — a `query` whose verdict is in is not asked again by the pass it starts', function () {

    for (const title of Object.keys(SCENES)) {
        test(title, async ({ page }) => {
            test.setTimeout(30000);
            const scene = SCENES[title];
            const run = await open(page, scene, true);
            if (typeof(scene.gatedBefore) != 'undefined') {
                expect((await state(page)).gated, 'the submit control before the gesture').toBe(scene.gatedBefore);
            }
            await act(page, scene);
            await expectNoRunaway(page, run);
            if (scene.submit) {
                await page.locator('#b1039-submit').click({ timeout: HARD });
                await page.waitForTimeout(SUBMIT);
                await expectNoRunaway(page, run);
            }
            const after = await state(page);
            expect(after.gated, 'the submit control').toBe(scene.expected.gated);
            expect(after.painted, 'the fields showing an error').toBe(scene.expected.painted);
            expect(run.posts, 'the submits that left').toBe(scene.expected.posts);
            expect(run.errors, 'no page error').toEqual([]);
        });
    }

    for (const title of Object.keys(NO_BREAKER)) {
        test(title, async ({ page }) => {
            test.setTimeout(30000);
            const scene = SCENES[NO_BREAKER[title]];
            const run = await open(page, scene, false);
            await act(page, scene);
            await expectNoRunaway(page, run);
            const after = await state(page);
            expect(after.gated, 'the submit control').toBe(scene.expected.gated);
            expect(run.errors, 'no page error').toEqual([]);
        });
    }

    test('30 CONTROL — the breaker fires on a chain of microtasks', async ({ page }) => {
        const scene = SCENES['18 CONTROL — a sync rule before `query`'];
        await open(page, scene, true);
        const tripped = await page.evaluate(() => new Promise((resolve) => {
            const chain = function () { window.queueMicrotask(chain); };
            chain();
            setTimeout(() => resolve(window.__b1039.tripped), 0);
        }));
        expect(tripped, 'the breaker stopped the chain').toBeGreaterThan(0);
    });
});
