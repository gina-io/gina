'use strict';
/**
 * The validator fix #B1037 — a form reset runs no live check: `resetFields` holds the live listeners
 * off while it writes, ends with one silent pass, and a pass or a `query` verdict that outlives the
 * reset paints nothing — pinned in the source, `resetFields` executed on its shipped bytes, and pinned
 * in both bundles. The behaviour is driven end-to-end on the real bundle by
 * `test/e2e/validator-form-reset-b1037.spec.js`.
 *
 *   §01 CONTROL — the premises the fix rests on, true on both sides of it: `ginaFormIsResetting` is
 *       one-shot; the collector writes `text` and `hidden` defaults on reset mode
 *   §02 source pins (comment-stripped): the listener guard sits before the `once` logic; the select
 *       guard is live again; the stale checks; the `reset.<id>` handler only calls `resetFields`; the
 *       `query` waiter's two predicates hold its store, paint and gate writes
 *   §03 `resetFields` EXTRACTED and EXECUTED with recording stubs: the flag is up during the writes and
 *       the collector and down afterwards, also after a throw; a removed control and an empty select;
 *       the collector's reset mode only from the reset path; the silent pass; the gate from its result
 *   §04 dist fidelity (both bundles)
 *
 * Red-first: `GINA_B1037_MAIN_SRC=<file>` points §02–§03 at another copy of the validator source
 * (e.g. `git show <commit>:<path>` before the change), and `GINA_B1037_DIST_DIR=<dir>` points §04 at
 * another dist js directory. Every arm must fail there except those labelled CONTROL.
 *
 * Usage: node --test test/core/validator-form-reset-b1037.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B1037_MAIN_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR = process.env.GINA_B1037_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var SRC = fs.readFileSync(MAIN, 'utf8');

/**
 * Drops whole-line comments (`//`, `/*`, ` *`), so a pin never matches prose or a `was:` copy of
 * the code.
 *
 * @param {string} src
 * @returns {string}
 */
function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * Counts the occurrences of a literal.
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}

/**
 * Cuts a function expression out of `src`, from `decl` (which must occur once) to its closing brace.
 *
 * @param {string} src
 * @param {string} decl - the text that starts the declaration
 * @returns {string} the text from `function` to the closing brace
 */
function cutFunction(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, 'declaration not found: ' + decl);
    assert.equal(src.indexOf(decl, at + decl.length), -1, 'declaration not unique: ' + decl);
    var from = src.indexOf('function', at);
    var depth = 0, started = false;
    for (var i = from; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; }
        if (started && depth === 0) { return src.substring(from, i + 1); }
    }
    assert.fail('unbalanced braces after: ' + decl);
}

var ACTIVE = activeLines(SRC);
var RESET_FN = cutFunction(ACTIVE, 'var resetFields = function(');

/** A stub control: what `resetFields` reads and writes. */
function control(id, tag, type, value) {
    return { id: id, tagName: tag, type: type, value: value, dataset: {}, checked: false, selectedIndex: 0, options: [] };
}

/**
 * Runs the extracted `resetFields` over a stub record.
 *
 * @param {object} opt
 * @param {object} opt.controls - the page's controls by id; an id absent here reads as removed
 * @param {object} opt.fieldsSet - the record's `fieldsSet`
 * @param {Array} [opt.args] - what follows the record in the call
 * @param {function} [opt.onTrigger] - called on each `triggerEvent`
 * @param {string} [opt.liveCheck] - the form's `ginaFormLiveCheckEnabled`, as a bind writes it
 * @returns {{record: object, calls: Array, thrown: Error|null, passCb: function|null, target: object}}
 */
function runReset(opt) {
    var calls = [], passCb = { fn: null };
    var target = { dataset: {}, getAttribute: function () { return 'f1'; } };
    if (opt.liveCheck) { target.dataset.ginaFormLiveCheckEnabled = opt.liveCheck; }
    Object.keys(opt.controls).forEach(function (id) { opt.controls[id].form = target; });
    var record = { target: target, fieldsSet: opt.fieldsSet, rules: {}, errors: { old: {} } };
    var isUp = function () { return record.isBeingReseted === true; };
    var stubs = {
        document: { getElementById: function (id) { return opt.controls[id] || null; } },
        gina: {},
        instance: { $forms: { f1: record } },
        console: { debug: function () {} },
        triggerEvent: function (g, el, name) {
            calls.push(['trigger', el.id, name, isUp()]);
            if (opt.onTrigger) { opt.onTrigger(el); }
        },
        getFormValidationInfos: function () {
            calls.push(['collect', arguments.length, arguments[2], isUp()]);
            return { fields: { a: 1 }, $fields: { a: {} } };
        },
        handleErrorsDisplay: function (t, errors) {
            calls.push(['clear', t.dataset.ginaFormIsResetting, isUp(), JSON.stringify(record.errors)]);
            t.dataset.ginaFormIsResetting = false;
        },
        validate: function (t, fields, $fields, rules, cb) {
            calls.push(['validate', cb.isSilentPass === true, isUp()]);
            passCb.fn = cb;
        },
        updateSubmitTriggerState: function (t, isValid) { calls.push(['gate', t === target, isValid]); }
    };
    var names = Object.keys(stubs);
    var fn = new Function(names.join(','), 'return (' + RESET_FN + ');').apply(null, names.map(function (n) { return stubs[n]; }));
    var thrown = null;
    try {
        fn.apply(null, [record].concat(opt.args || []));
    } catch (e) {
        thrown = e;
    }
    return { record: record, calls: calls, thrown: thrown, passCb: passCb.fn, target: target };
}

describe('validator-form-reset-b1037 §01 — the premises (CONTROL)', function () {

    it('01.1 CONTROL — `ginaFormIsResetting` is one-shot: the catch in handleErrorsDisplay puts it down', function () {
        var fn = cutFunction(ACTIVE, 'var handleErrorsDisplay = function(');
        var catchAt = fn.indexOf('/^(true)$/i.test($form.dataset.ginaFormIsResetting)');
        assert.ok(catchAt > -1);
        assert.ok(fn.indexOf('$form.dataset.ginaFormIsResetting = false;', catchAt) > catchAt);
    });

    it('01.2 CONTROL — on reset mode the collector writes `text` and `hidden` defaults through the setter', function () {
        var fn = cutFunction(ACTIVE, 'var getFormValidationInfos = function(');
        assert.ok(fn.indexOf('if ( isOnResetMode ) {') > -1);
        assert.ok(fn.indexOf('$form[i].value = $form[i].defaultValue;') > -1);
    });
});

describe('validator-form-reset-b1037 §02 — source pins', function () {

    var LIVE = cutFunction(ACTIVE, 'var addLiveForInput = function(');
    var SELECT = cutFunction(ACTIVE, 'var updateSelect = function(');

    it('02.1 the live listener returns during a reset, before the radio and checkbox `once` logic', function () {
        var guard = LIVE.indexOf('if ( $liveForm.isBeingReseted ) {');
        var onceLogic = LIVE.indexOf('if ( !once && /^changed\\./i.test(event.type)');
        assert.ok(guard > -1, 'the guard');
        assert.ok(onceLogic > -1, 'the anchor');
        assert.ok(guard < onceLogic, 'the guard comes first');
    });

    it('02.2 a live pass that outlived a reset stops at each of its three steps, and leaves its flags down', function () {
        assert.equal(count(LIVE, 'if ( isStaleAfterReset() ) {'), 3);
        var fn = LIVE.substring(LIVE.indexOf('var isStaleAfterReset = function('), LIVE.indexOf('var processEvent = function('));
        assert.ok(fn.indexOf('$liveForm.isValidating = false;') > -1);
        assert.ok(fn.indexOf('once = false;') > -1);
    });

    it('02.3 the select path: the guard is live, and both callbacks stop when the pass is stale', function () {
        assert.ok(SELECT.indexOf("&& !instance.$forms[$el.form.getAttribute('id')].isBeingReseted") > -1);
        assert.equal(count(SELECT, 'if ( isStaleAfterReset() ) {'), 2);
    });

    it('02.4 the `reset.<id>` handler only calls resetFields, on reset mode', function () {
        var at = ACTIVE.indexOf("subEvent = 'reset.'+$target.id;");
        assert.ok(at > -1);
        var handler = ACTIVE.substring(at, ACTIVE.indexOf("addListener(gina, $target, 'reset', resetProxyHandler)", at));
        assert.equal(count(handler, 'resetFields($form, true);'), 1);
        assert.equal(count(handler, 'validate('), 0, 'no pass of its own');
        assert.equal(count(handler, 'ginaFormIsResetting'), 0);
    });

    it('02.5 the `query` waiter: a stale verdict and a silent pass store and paint nothing', function () {
        assert.equal(count(ACTIVE, 'var isStaleVerdict = ( instance.$forms[formId].resetCount || 0 ) != resetCountAtPassStart;'), 1);
        assert.equal(count(ACTIVE, 'var isDisplayHeld = isStaleVerdict || !!( cb && cb.isSilentPass );'), 1);
        assert.equal(count(ACTIVE, "if ( typeof(cb._errors[field]) != 'undefined' && !isDisplayHeld ) {"), 1, 'the store');
        assert.equal(count(ACTIVE, 'if (!isFormValid && /^true|false$/i.test(instance.$forms[formId].isValidating) && !isDisplayHeld) {'), 1, 'the last-field branch');
        assert.match(ACTIVE, /if \(isStaleVerdict\) \{\s*needsGlobalReValidation = false;\s*\}/, 'a stale verdict starts no inner pass');
        assert.equal(count(ACTIVE, 'onSilentQueryGlobalLiveValidation.isSilentPass = isDisplayHeld;'), 1, 'the inner pass inherits it');
    });

    it('02.6 the pass count is read once, on the client path', function () {
        assert.equal(count(ACTIVE, 'resetCountAtPassStart = instance.$forms[id].resetCount || 0;'), 1);
    });

    it('02.7 the reset pass takes the rescue of a clean verdict on a query field not last (#B348)', function () {
        assert.equal(count(RESET_FN, 'onSilentResetValidation.isRevealCompletion = true;'), 1);
        assert.ok(ACTIVE.indexOf('&& cb && cb.isRevealCompletion') > -1, 'the rescue reads it');
    });

    it('02.8 a silent pass ignores the answer to another value, before the waiter consumes its one wake-up', function () {
        var at = ACTIVE.indexOf('function onasyncCompleted(event) {');
        var guard = ACTIVE.indexOf('String(event.detail.value).toLowerCase() != String(d[field].value).toLowerCase()', at);
        var consume = ACTIVE.indexOf('event.currentTarget.removeEventListener(event.type, onasyncCompleted, false);', at);
        assert.ok(at > -1 && guard > -1 && consume > -1);
        assert.ok(guard < consume);
        assert.ok(ACTIVE.substring(at, guard).indexOf('cb && cb.isSilentPass') > -1, 'only a silent pass');
    });

    it('02.11 a stale verdict that would have started the inner pass puts its flag down', function () {
        var guard = ACTIVE.indexOf('if (isStaleVerdict && needsGlobalReValidation) {');
        assert.ok(guard > -1);
        assert.ok(ACTIVE.indexOf('instance.$forms[formId].isValidating = false;', guard) - guard < 120);
        assert.ok(guard < ACTIVE.indexOf('if (isStaleVerdict) {'), 'read before it is cancelled');
    });

    it('02.10 a submit refused after a reset is released with nothing painted; a valid one still sends', function () {
        var fn = cutFunction(ACTIVE, 'var releaseSubmitRefusedAfterReset = function(');
        var calls = [];
        var run = new Function('disarmSubmitLoading', 'return (' + fn + ');')(function (r) { calls.push('disarm'); });
        var record = function () { return { resetCount: 2, isSubmitting: true }; };
        var refused = { isValid: function () { return false; } }, valid = { isValid: function () { return true; } };
        assert.equal(run(undefined, 1, refused), false, 'a destroyed record: nothing to release');
        var r = record();
        assert.equal(run(r, 1, refused), true, 'refused after a reset: dropped');
        assert.equal(r.isSubmitting, false);
        assert.deepEqual(calls, ['disarm']);
        r = record();
        assert.equal(run(r, 1, valid), false, 'valid after a reset: it goes on');
        assert.equal(r.isSubmitting, true);
        r = record();
        assert.equal(run(r, 2, refused), false, 'no reset: the refusal goes on');
        assert.equal(r.isSubmitting, true);
        calls.length = 0;
        r = record();
        r.isSending = true;
        assert.equal(run(r, 1, refused), true);
        assert.deepEqual(calls, [], 'an earlier request in flight keeps its loading state');
        assert.equal(count(ACTIVE, 'if ( releaseSubmitRefusedAfterReset(instance.$forms[id], resetCountAtClick, result) ) {'), 1, 'the click');
        assert.equal(count(ACTIVE, 'if ( releaseSubmitRefusedAfterReset(instance.$forms[id], resetCountAtSubmit, result) ) {'), 1, 'submit()');
    });

    it('02.9 after a reset, the timer of a master checkbox reads the form again, group applied, silently', function () {
        var fn = cutFunction(ACTIVE, 'var updateCheckBox = function(');
        assert.ok(fn.indexOf('if ( !isInit && $form.isBeingReseted ) {') > -1);
        assert.equal(count(fn, 'readGroupAfterReset();'), 2, 'both timers');
        ['triggerHandleCheckBoxGroupDependencies($el, checkBoxGroup, true);', 'triggerHandleCheckBoxGroupDependencies($el, checkBoxGroup, false);'].forEach(function (apply) {
            assert.ok(fn.indexOf(apply) > -1);
            assert.ok(fn.indexOf('readGroupAfterReset();', fn.indexOf(apply)) > fn.indexOf(apply), 'after the group is applied');
        });
        var silent = cutFunction(ACTIVE, 'var revalidateSilently = function(');
        assert.equal(count(silent, 'onSilentAutofillValidation.isSilentPass = true;'), 1);
    });
});

describe('validator-form-reset-b1037 §03 — resetFields executed on the shipped bytes', function () {

    var fieldsSet = {
        t1: { defaultValue: 'd1' },
        a1: { defaultValue: 'd2' },
        c1: { defaultChecked: true }
    };
    var controls = function () {
        return {
            t1: control('t1', 'INPUT', 'text', 'typed'),
            a1: control('a1', 'TEXTAREA', 'textarea', 'typed'),
            c1: control('c1', 'INPUT', 'checkbox', 'yes')
        };
    };

    it('03.1 the values are restored with the flag up, and it is down when the pass starts', function () {
        var els = controls();
        var r = runReset({ controls: els, fieldsSet: fieldsSet });
        assert.equal(r.thrown, null);
        assert.equal(els.t1.value, 'd1');
        assert.equal(els.a1.value, 'd2');
        assert.equal(els.c1.checked, true);
        var triggers = r.calls.filter(function (c) { return c[0] === 'trigger'; });
        assert.equal(triggers.length, 3);
        assert.ok(triggers.every(function (c) { return c[3] === true; }), 'flag up during every trigger');
        var v = r.calls.filter(function (c) { return c[0] === 'validate'; });
        assert.equal(v.length, 1, 'one pass');
        assert.equal(v[0][2], false, 'flag down at the pass');
        assert.equal(r.record.isBeingReseted, undefined);
        assert.equal(r.record.resetCount, 1, 'the count moved');
    });

    it('03.2 the collector runs under the flag; its reset mode comes only from the reset path', function () {
        var plain = runReset({ controls: controls(), fieldsSet: fieldsSet });
        var collect = plain.calls.filter(function (c) { return c[0] === 'collect'; });
        assert.equal(collect.length, 1);
        assert.equal(collect[0][1], 2, 'resetFields() alone: two arguments, values stay as restored');
        assert.equal(collect[0][3], true, 'under the flag');

        var onReset = runReset({ controls: controls(), fieldsSet: fieldsSet, args: [true] });
        var collectReset = onReset.calls.filter(function (c) { return c[0] === 'collect'; });
        assert.equal(collectReset[0][2], true, 'the reset path: reset mode');
        assert.equal(collectReset[0][3], true, 'under the flag');

        var truthy = runReset({ controls: controls(), fieldsSet: fieldsSet, args: [{}] });
        assert.equal(truthy.calls.filter(function (c) { return c[0] === 'collect'; })[0][1], 2, 'only `true` is reset mode');
    });

    it('03.3 the display and the store are cleared once, with the flag that catches a reset, before the pass', function () {
        var r = runReset({ controls: controls(), fieldsSet: fieldsSet });
        var names = r.calls.map(function (c) { return c[0]; });
        var clears = r.calls.filter(function (c) { return c[0] === 'clear'; });
        assert.equal(clears.length, 1, 'one clear');
        assert.equal(clears[0][1], true, 'the one-shot flag is up for it');
        assert.equal(clears[0][2], false, 'after the writes');
        assert.equal(clears[0][3], '{}', 'the store is emptied first');
        assert.ok(names.indexOf('clear') < names.indexOf('validate'));
    });

    it('03.4 the pass is silent and only re-reads the gate', function () {
        var r = runReset({ controls: controls(), fieldsSet: fieldsSet });
        assert.equal(r.calls.filter(function (c) { return c[0] === 'validate'; })[0][1], true, 'isSilentPass');
        assert.equal(typeof r.passCb, 'function');
        var before = r.calls.length;
        r.passCb({ isValid: function () { return false; } });
        var after = r.calls.slice(before);
        assert.deepEqual(after, [['gate', true, false]]);
    });

    it('03.5 a control removed from the page is skipped, the others are restored', function () {
        var els = controls();
        delete els.a1;
        var r = runReset({ controls: els, fieldsSet: fieldsSet });
        assert.equal(r.thrown, null);
        assert.equal(els.t1.value, 'd1');
        assert.equal(els.c1.checked, true);
        assert.equal(r.calls.filter(function (c) { return c[0] === 'validate'; }).length, 1);
    });

    it('03.6 an empty select is restored to nothing, no throw', function () {
        var sel = control('s1', 'SELECT', 'select-one', '');
        sel.selectedIndex = -1;
        Object.defineProperty(sel, 'selectedIndex', { get: function () { return -1; }, set: function () {} });
        var r = runReset({ controls: { s1: sel }, fieldsSet: { s1: {} } });
        assert.equal(r.thrown, null);
        assert.equal(sel.dataset.value, '');
    });

    it('03.8 live check off: resetFields() runs no pass, a reset event keeps it; the display is cleared on both', function () {
        var off = runReset({ controls: controls(), fieldsSet: fieldsSet, liveCheck: 'false' });
        assert.equal(off.calls.filter(function (c) { return c[0] === 'validate'; }).length, 0, 'resetFields(): no pass');
        assert.equal(off.calls.filter(function (c) { return c[0] === 'clear'; }).length, 1, 'the display is cleared');
        var event = runReset({ controls: controls(), fieldsSet: fieldsSet, liveCheck: 'false', args: [true] });
        assert.equal(event.calls.filter(function (c) { return c[0] === 'validate'; }).length, 1, 'a reset event: its pass');
        var on = runReset({ controls: controls(), fieldsSet: fieldsSet, liveCheck: 'true' });
        assert.equal(on.calls.filter(function (c) { return c[0] === 'validate'; }).length, 1, 'live check on: its pass');
    });

    it('03.9 a request in flight: a valid verdict leaves the trigger to the settle, an invalid one still gates', function () {
        var r = runReset({ controls: controls(), fieldsSet: fieldsSet });
        r.record.isSending = true;
        var before = r.calls.length;
        r.passCb({ isValid: function () { return true; } });
        assert.deepEqual(r.calls.slice(before), [], 'the lock stays');
        r.passCb({ isValid: function () { return false; } });
        assert.deepEqual(r.calls.slice(before), [['gate', true, false]]);
        r.record.isSending = false;
        r.passCb({ isValid: function () { return true; } });
        assert.deepEqual(r.calls.slice(-1), [['gate', true, true]], 'settled: the gate is written');
    });

    it('03.7 the flag comes down when the loop throws, and the error still reaches the caller', function () {
        var r = runReset({
            controls: controls(), fieldsSet: fieldsSet,
            onTrigger: function () { throw new Error('boom'); }
        });
        assert.equal(r.thrown && r.thrown.message, 'boom');
        assert.equal(r.record.isBeingReseted, undefined, 'the flag is down');
    });
});

describe('validator-form-reset-b1037 §04 — dist fidelity', function () {

    var RAW = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var MIN = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8');

    /** A regular expression from literal tokens, tolerant of Closure's line wraps between them. */
    function tokens() {
        return new RegExp(Array.prototype.map.call(arguments, function (t) {
            return (t instanceof RegExp) ? t.source : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('\\s*'));
    }

    it('04.1 gina.js carries the guard, the pass and the waiter\'s predicates', function () {
        assert.equal(count(RAW, 'if ( $liveForm.isBeingReseted ) {'), 1);
        assert.equal(count(RAW, 'onSilentResetValidation.isSilentPass = true;'), 1);
        assert.equal(count(RAW, 'var isDisplayHeld = isStaleVerdict || !!( cb && cb.isSilentPass );'), 1);
        assert.equal(count(RAW, 'resetFields($form, true);'), 1);
        assert.equal(count(RAW, 'onSilentResetValidation.isRevealCompletion = true;'), 1);
        assert.equal(count(RAW, 'readGroupAfterReset();'), 2);
        assert.equal(count(RAW, 'String(event.detail.value).toLowerCase() != String(d[field].value).toLowerCase()'), 1);
    });

    it('04.2 gina.min.js: the flag and the count at the top of the reset, the try', function () {
        assert.match(MIN, tokens('.isBeingReseted=', '!0', ';', /\w+/, '.resetCount=(', /\w+/, '.resetCount||0)+1', ';', 'try', '{'));
    });

    it('04.3 gina.min.js: the listener\'s guard', function () {
        assert.match(MIN, tokens('if(', /\w+/, '.isBeingReseted)', 'return!1'));
    });

    it('04.4 gina.min.js: the silent pass is marked and read', function () {
        assert.match(MIN, tokens('.isSilentPass=', '!0'));
        assert.match(MIN, tokens('.isSilentPass)'));
        assert.match(MIN, tokens('.isRevealCompletion=', '!0'));
        assert.match(MIN, tokens('.detail.value).toLowerCase()'));
    });
});
