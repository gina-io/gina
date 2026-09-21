'use strict';
/**
 * FormValidator — a REJECTED submit must release the `isSubmitting` latch (#B192)
 *
 * `bindSubmitEl` sets `instance.$forms[id].isSubmitting = true` before running validation, and the
 * live-check field listener hard-returns while that flag is truthy — that is deliberate: it keeps
 * live-check quiet while a submit is actually in flight.
 *
 * The bug: the ONLY site that cleared the flag was the XHR settle (`xhr.onreadystatechange`), which
 * a rejected submit never reaches — it sends nothing. So an invalid submit attempt latched the flag
 * true forever: every subsequent keystroke was swallowed by the gate, `updateSubmitTriggerState`
 * never ran again, and the submit trigger kept `aria-disabled="true"` + `.gina-form-submit-disabled`
 * until the page was reloaded. Because the flag lives on the `$forms[id]` OBJECT (not on a listener
 * closure), it also survived a full unbind/rebind — `reBind()` re-gated correctly but never restored
 * the live check.
 *
 * The fix releases the latch at the top of the internal `validate.<id>` handler's INVALID branch —
 * the terminal no-send outcome — leaving the valid branch's latch to be cleared by the XHR settle as
 * before.
 *
 * Strategy (same convention as validator-submit-trigger-state / validator-aria-invalid):
 *  - test-local replicas of the three latch touch-points (set / gate / clear) driven against a real
 *    jsdom DOM, since they are closure-private inside `ValidatorPlugin` and cannot be instantiated
 *    in node:test;
 *  - a `preFix` switch on the handler replica so the suite distinguishes the fix from the bug
 *    (subtract), including the reBind-survival property the consumer measured;
 *  - source-inspection pins locking the shipped shape of all three touch-points plus the ordering of
 *    the release relative to the #A11Y1 focus block;
 *  - dist-fidelity pins so a missed bundle rebuild cannot ship the fix server-side only.
 *
 * NB on the dist pins: Closure (SIMPLE_OPTIMIZATIONS) emits `false` as `!1` and `true` as `!0`, and
 * strips comments — so `gina.min.js` is pinned on the `isSubmitting=!1` / `=!0` forms and the
 * un-minified `gina.js` (the prod intermediate, RequireJS `optimize: "none"`) on the readable form.
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW      = require('../fw');
var MAIN    = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST    = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var DIST_UM = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

var mainSrc, distSrc, distUnminSrc;
before(function () {
    mainSrc      = fs.readFileSync(MAIN, 'utf8');
    distSrc      = fs.readFileSync(DIST, 'utf8');
    distUnminSrc = fs.readFileSync(DIST_UM, 'utf8');
});


// --- Replicas of the three latch touch-points ------------------------------------------------ //

// main.js `bindSubmitEl`: the submit path arms the latch before running validation.
function armLatch($forms, id) {
    $forms[id].isSubmitting = true;
    $forms[id].isSending    = false;
}

// main.js live-check field listener: hard-return while the latch is truthy.
// Returns true when the live check is allowed to proceed to `processEvent`.
function liveCheckMayRun($forms, event) {
    if (
        typeof($forms[event.target.form.getAttribute('id')].isSubmitting) != 'undefined'
        && /true/i.test($forms[event.target.form.getAttribute('id')].isSubmitting)
    ) {
        return false;
    }
    return true;
}

// main.js `xhr.onreadystatechange`: the send path's release (untouched by the fix).
function xhrSettle($form) {
    $form.isSubmitting = false;
}

// main.js internal `validate.<id>` handler. `preFix` omits the #B192 release so the suite can
// subtract the fix. The #A11Y1 focus loop itself is locked by validator-submit-trigger-state §02;
// only its ORDER relative to the release matters here.
function runValidateHandler($forms, _id, result, sendSpy, preFix) {
    var order = [];
    if ( typeof(result['isValid']) != 'undefined' && result['isValid']() ) { // send if valid
        if ( $forms[_id] ) {
            order.push('send');
            sendSpy(result['data']);
        }
    } else {
        if (!preFix) { // #B192 — release the latch on the terminal no-send outcome
            if ( $forms[_id] ) {
                order.push('release');
                $forms[_id].isSubmitting = false;
            }
        }
        order.push('a11yFocus');
    }
    return order;
}


// --- Fixtures --------------------------------------------------------------------------------- //

function makeScene() {
    var dom = new JSDOM('<!doctype html><html><body>' +
        '<form id="parent" data-gina-form-live-check-enabled="true">' +
            '<div class="form-item"><input name="myField" id="myField" type="text"></div>' +
            '<button id="parentSubmit" type="submit">Send</button>' +
        '</form></body></html>');
    var doc   = dom.window.document;
    var field = doc.getElementById('myField');
    // mirrors `instance.$forms` — the object identity is what survives a rebind
    var $forms = { parent: { isSubmitting: null, isSending: null, errors: null } };
    return {
        window  : dom.window,
        document: doc,
        form    : doc.getElementById('parent'),
        field   : field,
        trigger : doc.getElementById('parentSubmit'),
        $forms  : $forms,
        // a keyup on the field, as the live-check listener receives it
        keyup   : function () { return { target: field, type: 'keyup.myField' }; }
    };
}

var INVALID = {
    fields : { myField: { isRequired: 'Cannot be left empty' } },
    data   : { myField: '' },
    isValid: function () { return false; }
};
var VALID = {
    fields : null,
    data   : { myField: 'ok' },
    isValid: function () { return true; }
};


// 01 - the gate replica itself: known-positive AND known-negative, before it is trusted
describe('01 - live-check gate replica: validated against both a blocking and a non-blocking state', function () {
    it('a freshly-initialised form (isSubmitting null) does NOT block the live check', function () {
        var ctx = makeScene();
        assert.equal(ctx.$forms.parent.isSubmitting, null, 'the init value, per main.js $forms defaults');
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true);
    });

    it('a latched form (isSubmitting true) DOES block the live check — the instrument can fire', function () {
        var ctx = makeScene();
        ctx.$forms.parent.isSubmitting = true;
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false);
    });

    it('a released form (isSubmitting false) does NOT block — `false` is not matched by /true/i', function () {
        var ctx = makeScene();
        ctx.$forms.parent.isSubmitting = false;
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true);
    });
});


// 02 - the fix: a rejected submit releases the latch, so the live check survives it
describe('02 - rejected submit releases the latch: the live check keeps running', function () {
    it('arms the latch on the submit attempt (pre-condition, mirrors bindSubmitEl)', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        assert.equal(ctx.$forms.parent.isSubmitting, true);
        assert.equal(ctx.$forms.parent.isSending, false);
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false, 'blocked while the submit runs');
    });

    it('the invalid branch releases it, and the next keystroke reaches the live check', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        runValidateHandler(ctx.$forms, 'parent', INVALID, function () {
            throw new Error('an invalid form must not send');
        });
        assert.equal(ctx.$forms.parent.isSubmitting, false, 'latch released on the no-send outcome');
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true, 'the live check runs again');
    });

    it('releases BEFORE the #A11Y1 focus block (ordering — focus must not depend on the release)', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        var order = runValidateHandler(ctx.$forms, 'parent', INVALID, function () {});
        assert.deepEqual(order, ['release', 'a11yFocus']);
    });

    it('repeated rejected submits stay releasable (the latch does not accumulate)', function () {
        var ctx = makeScene();
        for (var i = 0; i < 3; i++) {
            armLatch(ctx.$forms, 'parent');
            runValidateHandler(ctx.$forms, 'parent', INVALID, function () {});
            assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true, 'attempt ' + (i + 1));
        }
    });

    it('guards a destroyed form instance: no throw when $forms[_id] is gone', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        delete ctx.$forms.parent;
        assert.doesNotThrow(function () {
            runValidateHandler(ctx.$forms, 'parent', INVALID, function () {});
        });
    });
});


// 03 - subtract the fix: the pre-fix invalid branch is the reported lockup
describe('03 - subtract-the-fix: the pre-fix rejected submit latches the live check dead', function () {
    it('pre-fix, the latch stays true after a rejected submit', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        runValidateHandler(ctx.$forms, 'parent', INVALID, function () {}, true /* preFix */);
        assert.equal(ctx.$forms.parent.isSubmitting, true, 'pre-fix: nothing clears it on this path');
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false, 'pre-fix: the live check is dead');
    });

    it('pre-fix, EVERY subsequent keystroke stays blocked (the "until reload" property)', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        runValidateHandler(ctx.$forms, 'parent', INVALID, function () {}, true);
        for (var i = 0; i < 5; i++) {
            assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false, 'keystroke ' + (i + 1));
        }
        // post-fix, on the same scene shape, the first keystroke already gets through:
        var ctx2 = makeScene();
        armLatch(ctx2.$forms, 'parent');
        runValidateHandler(ctx2.$forms, 'parent', INVALID, function () {});
        assert.equal(liveCheckMayRun(ctx2.$forms, ctx2.keyup()), true, 'post-fix: released');
    });

    it('pre-fix, a full unbind/rebind does NOT restore it — the latch is on the $forms object', function () {
        var ctx = makeScene();
        var $formInstance = ctx.$forms.parent;
        armLatch(ctx.$forms, 'parent');
        runValidateHandler(ctx.$forms, 'parent', INVALID, function () {}, true);
        // reBindForm re-attaches listeners against the SAME $forms[id] instance
        ctx.$forms.parent = $formInstance;
        assert.equal(ctx.$forms.parent.isSubmitting, true, 'the flag survives the rebind');
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false, 'still dead after reBind()');
    });

    it('control: with NO submit attempt at all, the live check was never blocked either way', function () {
        var ctx = makeScene();
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true);
        // this is the consumer subtract arm — it isolates the submit attempt as the trigger
    });
});


// 04 - the valid path keeps its latch: the fix must not un-gate a real in-flight submit
describe('04 - valid submit: the latch survives the handler and is cleared by the XHR settle', function () {
    it('the valid branch sends and does NOT release the latch', function () {
        var ctx = makeScene();
        var sent = [];
        armLatch(ctx.$forms, 'parent');
        var order = runValidateHandler(ctx.$forms, 'parent', VALID, function (d) { sent.push(d); });
        assert.deepEqual(order, ['send']);
        assert.equal(sent.length, 1, 'a valid form sends');
        assert.equal(ctx.$forms.parent.isSubmitting, true, 'still latched while the request is in flight');
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), false, 'live-check stays quiet during the send');
    });

    it('the XHR settle then releases it (the pre-existing clear, untouched by the fix)', function () {
        var ctx = makeScene();
        armLatch(ctx.$forms, 'parent');
        runValidateHandler(ctx.$forms, 'parent', VALID, function () {});
        xhrSettle(ctx.$forms.parent);
        assert.equal(ctx.$forms.parent.isSubmitting, false);
        assert.equal(liveCheckMayRun(ctx.$forms, ctx.keyup()), true);
    });
});


// 05 - source pins: the three latch touch-points + the release's placement
describe('05 - source pins: latch set / gate / clear + the #B192 release', function () {
    it('THE FIX: the invalid branch releases the latch, guarded on the form instance', function () {
        assert.match(
            mainSrc,
            /if \( instance\.\$forms\[_id\] \) \{\s*instance\.\$forms\[_id\]\.isSubmitting = false;\s*\}/
        );
    });

    it('the release sits INSIDE the invalid branch, before the #A11Y1 focus block', function () {
        var send    = mainSrc.indexOf("result['isValid']() ) { // send if valid");
        var release = mainSrc.indexOf('instance.$forms[_id].isSubmitting = false;');
        var a11y    = mainSrc.indexOf('// #A11Y1 (slice 3) — failed submit');
        assert.ok(send    > -1, 'the send gate anchor exists');
        assert.ok(release > -1, 'the release exists');
        assert.ok(a11y    > -1, 'the #A11Y1 block anchor exists');
        assert.ok(release > send, 'the release is below the valid branch (i.e. in the else)');
        assert.ok(release < a11y, 'the release runs before the focus loop');
    });

    it('the valid branch does NOT touch the latch (its clear stays the XHR settle)', function () {
        var send = mainSrc.indexOf("result['isValid']() ) { // send if valid");
        var els  = mainSrc.indexOf('// #B192', send);
        assert.ok(els > send, 'the #B192 comment marks the start of the else branch');
        assert.equal(
            /isSubmitting/.test(mainSrc.slice(send, els)), false,
            'no isSubmitting write between the send gate and the release'
        );
    });

    it('latch-set control: bindSubmitEl arms it before validation', function () {
        assert.match(
            mainSrc,
            /instance\.\$forms\[id\]\.isSubmitting = true;\s*instance\.\$forms\[id\]\.isSending = false;/
        );
    });

    it('live-check gate control: the field listener hard-returns while latched', function () {
        assert.match(
            mainSrc,
            /typeof\(instance\.\$forms\[event\.target\.form\.getAttribute\('id'\)\]\.isSubmitting\) != 'undefined'\s*&& \/true\/i\.test\(instance\.\$forms\[event\.target\.form\.getAttribute\('id'\)\]\.isSubmitting\)\s*\) \{\s*return false;/
        );
    });

    it('XHR-settle control: the send path still clears it in onreadystatechange', function () {
        // gh#76 slice 4: `data-gina-form-sync="replace"` aborts the in-flight XHR, whose handler
        // then settles SYNCHRONOUSLY inside the aborting send() — before that send has claimed
        // the latch. The clear is therefore guarded; pin the guard too, not only the clear.
        assert.match(
            mainSrc,
            /xhr\.onreadystatechange = function onValidationCallback\(event\) \{(?:\s*\/\/[^\n]*\n)*\s*if \( !sendCtx\.superseded \) \{\s*\$form\.isSubmitting = false;\s*\}/
        );
    });

    it('the complete write roster: exactly two arms and exactly three releases (#B346 added one of each)', function () {
        assert.deepEqual(
            mainSrc.match(/isSubmitting\s*=\s*(?:true|false)/g) || [],
            ['isSubmitting = false', 'isSubmitting = false', 'isSubmitting = true', 'isSubmitting = true', 'isSubmitting = false'],
            // file order, NOT call order: the internal validate.<id> handler is declared
            // ABOVE bindSubmitEl, so the #B192 release precedes that arm textually.
            'in file order: the XHR settle (:2203), the #B192 release (:8243), the bindSubmitEl arm (:8387), '
            + 'the #B346 pending-window latch (:8744), the #B346 pre-submit.<id> release (:8762)'
        );
    });

    it('the rationale comment is pinned so the release is not silently dropped', function () {
        assert.match(mainSrc, /#B192 — release the submit latch/);
        assert.match(mainSrc, /never reaches the XHR settle/);
    });
});


// 06 - dist fidelity: the browser bundle actually carries the release
describe('06 - dist fidelity: the rebuilt bundle carries the release', function () {
    it('gina.min.js carries THREE isSubmitting releases (Closure emits `false` as `!1`)', function () {
        assert.equal((distSrc.match(/isSubmitting\s*=\s*!1/g) || []).length, 3,
            'the XHR settle + the #B192 release + the #B346 pre-submit.<id> release');
    });

    it('gina.min.js carries exactly TWO arms (`true` as `!0`) — bindSubmitEl\'s and the #B346 pending-window latch', function () {
        // \s* is load-bearing: Closure's content-dependent line wrap can land
        // inside the assignment (measured: `isSubmitting=\n!0`), and a
        // line-oriented counter (grep -o) undercounts it.
        assert.equal((distSrc.match(/isSubmitting\s*=\s*!0/g) || []).length, 2);
    });

    it('the un-minified prod intermediate carries the readable release form three times', function () {
        assert.equal((distUnminSrc.match(/isSubmitting = false/g) || []).length, 3);
        assert.match(distUnminSrc, /#B192 — release the submit latch/);
    });

    it('control: the minifier really ran — comments survive in gina.js and are stripped in gina.min.js', function () {
        assert.match(distUnminSrc, /#A11Y1/, 'comments survive the RequireJS concat');
        assert.doesNotMatch(distSrc, /#B192/, 'and are stripped by Closure');
    });
});
