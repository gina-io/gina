'use strict';
/**
 * FormValidator — the disabled-trigger reveal's completion identity (#B348)
 *
 * `revealValidationState`'s callback STARVED on any form whose async `query`
 * field was not declared last: the reveal pass is un-latched, writes neither
 * `isSubmitting` nor `isValidating`, and on a valid form its verdict is
 * clean — so its waiter completion matched NO dispatch branch (terminal
 * errors>0 / #B342 latch / last-field / display-only live-check else-if),
 * `onDisabledTriggerReveal` never ran, and the stale
 * `data-gina-form-submit-gated` marker never re-synced: a fully valid form
 * ate every later click (measured live — 2 clicks, 0 POSTs).
 *
 * The fix: the reveal's callback carries a completion identity
 * (`onDisabledTriggerReveal.isRevealCompletion = true`, the engine's own
 * `cb._data`/`cb._errors` property idiom), and the waiter's chain gains ONE
 * else-if chained after the display-only live-check arm, gated on the SAME
 * terminal condition the errors>0 block uses (`hasParsedAllRules &&
 * asyncCount <= 0` — what stops a multi-query-field early wake): a terminal
 * reveal completion that matched no other branch dispatches
 * `validated.<formId>` with its own cb. #B347's un-latched programmatic
 * submit carries no marker and is deliberately untouched (its own entry
 * gates any fix on a repro).
 *
 * #B1037 stamps the same identity on the silent pass of a form reset
 * (`onSilentResetValidation`): that pass writes neither flag either, so on a
 * clean verdict only this else-if calls it back.
 *
 * Division of labor (the #B319 pattern):
 *  - BEHAVIORAL choreography: test/e2e/validator-reveal-starve.spec.js —
 *    red-first validated (arm 01 failed the starve signature on the pre-fix
 *    bundle while the query-LAST control arm passed on the same bytes,
 *    pinning the defect to field order).
 *  - THIS file keeps the browserless `npm test` release gate able to detect
 *    the identity's removal: source pins on both edit sites, an extracted-
 *    real-bytes arm driving `revealValidationState` (the stamp is a runtime
 *    VALUE, not just a line), and dist pins.
 *  - Unlike #B319's local flag, `isRevealCompletion` is a PROPERTY name —
 *    Closure preserves it — so gina.min.js IS pinned here (exact count: the
 *    stamp + the consult, comments stripped).
 *
 * Comment-strip note: extractions strip `//`-comment lines first (the #B353
 * own-comment trap — this fix's comments carry brace-bearing lines).
 *
 * Red-first: every pin validated against the pre-fix bytes
 * (`git show <parent>:<path>`) — 0 pre-fix, expected count post-fix — and
 * the extracted pre-fix reveal demonstrably passed an UNSTAMPED callback.
 *
 * Run: node --test test/core/validator-reveal-completion.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW   = require('../fw');
var MAIN = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var MIN  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var mainSrc, distSrc, minSrc, activeSrc;

/** Occurrence count (never grep -c line semantics — the min bundle is one line). */
function countOf(haystack, needle) {
    return haystack.split(needle).length - 1;
}

/** Strip `//`-comment lines — the replace-code convention leaves brace-bearing lines. */
function stripLineComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

/** Started-flag brace walk from a unique declaration (comment-stripped input). */
function extractFn(src, decl) {
    assert.equal(countOf(src, decl), 1, 'decl not unique: ' + decl);
    var i = src.indexOf(decl);
    var depth = 0, started = false, j = i;
    while (j < src.length) {
        var c = src[j];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) break;
        }
        j++;
    }
    assert.ok(started && depth === 0 && j < src.length, 'unbalanced walk for: ' + decl);
    return src.substring(i, j + 1);
}

before(function () {
    mainSrc   = fs.readFileSync(MAIN, 'utf8');
    distSrc   = fs.readFileSync(DIST, 'utf8');
    minSrc    = fs.readFileSync(MIN, 'utf8');
    activeSrc = stripLineComments(mainSrc);
});

// ============================================================================
// 1. Source pins
// ============================================================================
describe('#B348 — source pins', function () {

    it('01 - the identity is stamped exactly twice, in revealValidationState and on the silent reset pass (#B1037), each BEFORE its validate call', function () {
        assert.equal(countOf(activeSrc, '.isRevealCompletion = true;'), 2, 'stamp count (active code)');
        var fn = extractFn(activeSrc, 'var revealValidationState = function($formInstance) {');
        var stampIdx = fn.indexOf('onDisabledTriggerReveal.isRevealCompletion = true;');
        var passIdx  = fn.indexOf('validate($target');
        assert.ok(stampIdx > -1, 'stamp missing from revealValidationState');
        assert.ok(passIdx > stampIdx, 'the stamp must precede the validate call that carries the cb');
        assert.ok(fn.indexOf('onDisabledTriggerReveal);', passIdx) > -1,
            'the stamped named callback must be what the pass receives');
        var resetStampIdx = activeSrc.indexOf('onSilentResetValidation.isRevealCompletion = true;');
        var resetPassIdx  = activeSrc.indexOf('$form.rules, onSilentResetValidation);');
        assert.ok(resetStampIdx > -1, 'stamp missing from the silent reset pass');
        assert.ok(resetPassIdx > resetStampIdx,
            'the stamp must precede the validate call that carries the silent reset pass');
    });

    it('02 - the waiter rescue consults the identity exactly once, terminal-gated', function () {
        assert.equal(countOf(activeSrc, 'cb && cb.isRevealCompletion'), 1, 'consult count (active code)');
        var i = activeSrc.indexOf('cb && cb.isRevealCompletion');
        // the guard must ride the SAME terminal condition the errors>0 block uses
        var windowText = activeSrc.substring(i - 400, i);
        assert.ok(/hasParsedAllRules\s*&&\s*asyncCount <= 0[\s\S]*$/.test(windowText),
            'the rescue must be gated on the terminal condition (multi-query early-wake guard)');
        // and it must dispatch the pass's own cb
        var after = activeSrc.substring(i, i + 300);
        assert.ok(after.indexOf("triggerEvent(gina, $formOrElement, 'validated.' + formId, cb);") > -1,
            'the rescue must dispatch validated.<formId> with the pass cb');
    });

    it('03 - the rescue is chained LAST: after the display-only live-check arm, before the re-validation block', function () {
        var liveArm = activeSrc.indexOf("listedFields[listedFields.length-1] != field ) {");
        var rescue  = activeSrc.indexOf('cb && cb.isRevealCompletion');
        var revalid = activeSrc.indexOf('if (needsGlobalReValidation) {');
        assert.ok(liveArm > -1 && rescue > -1 && revalid > -1, 'anchors missing');
        assert.ok(rescue > liveArm, 'rescue must come after the live-check display-only arm');
        assert.ok(revalid > rescue, 'rescue must sit before the needsGlobalReValidation block');
    });

    it('04 - exactly three code occurrences of the identity exist (two stamps + consult) — no further site adopted it silently', function () {
        assert.equal(countOf(activeSrc, 'isRevealCompletion'), 3);
    });

});

// ============================================================================
// 2. Behavioral — the extracted REAL bytes of revealValidationState
// ============================================================================
describe('#B348 — extracted revealValidationState behavior', function () {

    function driveReveal(withResult) {
        var fnSrc = extractFn(activeSrc, 'var revealValidationState = function($formInstance) {')
            .replace(/^var revealValidationState = /, '');
        var captured = { cb: null, display: null, focused: null, trigger: null };
        var factory = new Function(
            'getFormValidationInfos', 'validate', 'handleErrorsDisplay', 'focusFirstInvalidField', 'updateSubmitTriggerState',
            'excludeWithheldAutofill', // #B478 - the reveal pass narrows its collection; pass-through here (collection is stubbed)
            'return (' + fnSrc + ');'
        );
        var revealValidationState = factory(
            function () { return { fields: { note: '' }, $fields: {} }; },
            function ($t, f, $f, r, cb) { captured.cb = cb; },
            function ($t, errors, data) { captured.display = { errors: errors, data: data }; },
            function ($t, errors) { captured.focused = errors; return false; },
            function ($fi, isValid) { captured.trigger = { instance: $fi, isValid: isValid }; },
            function (info) { return info; }
        );
        var $formInstance = { target: { id: 'parent' }, rules: {} };
        revealValidationState($formInstance);
        if (withResult && captured.cb) { captured.cb(withResult); }
        return { captured: captured, $formInstance: $formInstance };
    }

    it('05 - the callback handed to validate() carries the completion identity', function () {
        var r = driveReveal(null);
        assert.equal(typeof r.captured.cb, 'function', 'the reveal must pass a function cb');
        assert.equal(r.captured.cb.isRevealCompletion, true,
            'the cb must carry isRevealCompletion — the waiter rescue consults exactly this');
    });

    it('06 - driving the cb runs the documented self-heal: display, focus, and the gate re-sync from the fresh verdict', function () {
        var verdict = { fields: null, error: {}, data: { d: 1 }, isValid: function () { return true; } };
        var r = driveReveal(verdict);
        assert.ok(r.captured.display, 'handleErrorsDisplay must run');
        assert.deepEqual(r.captured.display.errors, {});
        assert.deepEqual(r.captured.focused, {}, 'focusFirstInvalidField receives the same errors');
        assert.ok(r.captured.trigger, 'updateSubmitTriggerState must run');
        assert.equal(r.captured.trigger.instance, r.$formInstance,
            'the gate re-sync targets the form INSTANCE (the #B176 dual-shape arg)');
        assert.equal(r.captured.trigger.isValid, true, 'the re-sync carries the fresh verdict');
    });

    it('07 - guard shape: a missing/foreign cb never satisfies the rescue consult (the #B347 boundary)', function () {
        // Evaluate the consult expression itself against the shapes the waiter can see.
        var consult = function (cb) { return !!(cb && cb.isRevealCompletion); };
        assert.equal(consult(undefined), false, 'no cb (foreign pass) must not dispatch');
        assert.equal(consult(function () {}), false,
            'an unstamped cb (e.g. #B347\'s onSubmitValidation) must not dispatch — that fix is repro-gated');
        var stamped = function () {}; stamped.isRevealCompletion = true;
        assert.equal(consult(stamped), true);
    });

});

// ============================================================================
// 3. Dist fidelity — unminified AND minified (property names survive Closure)
// ============================================================================
describe('#B348 — dist pins', function () {

    it('08 - gina.js (optimize:"none") mirrors the source occurrences verbatim', function () {
        assert.equal(countOf(distSrc, 'onDisabledTriggerReveal.isRevealCompletion = true;'), 1);
        assert.equal(countOf(distSrc, 'cb && cb.isRevealCompletion'), 1);
        assert.equal(countOf(distSrc, 'isRevealCompletion'), countOf(mainSrc, 'isRevealCompletion'),
            'dist must carry the source verbatim, comments included');
    });

    it('09 - gina.min.js carries the two stamps + the consult (property name survives Closure; comments stripped)', function () {
        assert.equal(countOf(minSrc, 'isRevealCompletion'), 3,
            'exactly the two stamps and the consult must survive minification');
    });

});
