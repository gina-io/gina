'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW         = require('../fw');
var commentStrip = require('../strip-comments');
var EVENTS_SRC = fs.readFileSync(path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js'), 'utf8');
var MAIN_SRC   = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/main.js'), 'utf8');

// --- Test-local replicas of the post-#M21a code shape at both files. ---
// Mirror the source verbatim so the source-inspection block in section 05
// double-locks the replicas against drift.

var listenToXhrEventsReplica = function ($el, type, windowLike) {
    var htmlSuccesEventCallback = $el.target.getAttribute('data-gina-' + type + '-event-on-success') || null;
    if (htmlSuccesEventCallback != null) {
        if (/\((.*)\)/.test(htmlSuccesEventCallback)) {
            try { console.warn('[gina-event] function-call shape no longer supported on data-gina-' + type + '-event-on-success — use a bare identifier and register the handler on window: ' + htmlSuccesEventCallback); } catch (e) {}
        } else {
            $el.on('success.h' + type, windowLike[htmlSuccesEventCallback]);
        }
    }
    var htmlErrorEventCallback = $el.target.getAttribute('data-gina-' + type + '-event-on-error') || null;
    if (htmlErrorEventCallback != null) {
        if (/\((.*)\)/.test(htmlErrorEventCallback)) {
            try { console.warn('[gina-event] function-call shape no longer supported on data-gina-' + type + '-event-on-error — use a bare identifier and register the handler on window: ' + htmlErrorEventCallback); } catch (e) {}
        } else {
            $el.on('error.h' + type, windowLike[htmlErrorEventCallback]);
        }
    }
};

var listenToXhrFormEventsReplica = function ($form, windowLike) {
    var htmlSuccesEventCallback = $form.target.getAttribute('data-gina-form-event-on-submit-success') || null;
    if (htmlSuccesEventCallback != null) {
        if (/\((.*)\)/.test(htmlSuccesEventCallback)) {
            try { console.warn('[gina-form-event] function-call shape no longer supported on data-gina-form-event-on-submit-success — use a bare identifier and register the handler on window: ' + htmlSuccesEventCallback); } catch (e) {}
        } else {
            $form.on('success.hform', windowLike[htmlSuccesEventCallback]);
        }
    }
    var htmlErrorEventCallback = $form.target.getAttribute('data-gina-form-event-on-submit-error') || null;
    if (htmlErrorEventCallback != null) {
        if (/\((.*)\)/.test(htmlErrorEventCallback)) {
            try { console.warn('[gina-form-event] function-call shape no longer supported on data-gina-form-event-on-submit-error — use a bare identifier and register the handler on window: ' + htmlErrorEventCallback); } catch (e) {}
        } else {
            $form.on('error.hform', windowLike[htmlErrorEventCallback]);
        }
    }
};

var makeMockEl = function (attributes) {
    var onCalls = [];
    return {
        target: {
            getAttribute: function (name) {
                return (name in attributes) ? attributes[name] : null;
            }
        },
        on: function (event, handler) {
            onCalls.push({ event: event, handler: handler });
        },
        _onCalls: onCalls
    };
};

var captureWarn = function (fn) {
    var calls = [];
    var orig = console.warn;
    console.warn = function () {
        var args = [];
        for (var i = 0; i < arguments.length; i++) { args.push(arguments[i]); }
        calls.push(args);
    };
    try { fn(); } finally { console.warn = orig; }
    return calls;
};

var stripComments = function (src) {
    return commentStrip.all(src);
};


// --- 01 — events.js shape: bare-identifier branch behavioural parity ---
describe('01 — events.js bare-identifier branch (#M21a)', function () {

    it('registers success handler from window when attribute is a bare identifier', function () {
        var handler = function () {};
        var $el = makeMockEl({ 'data-gina-popin-event-on-success': 'mySuccessFn' });
        var win = { mySuccessFn: handler };

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', win);
        });

        assert.equal(warns.length, 0);
        assert.equal($el._onCalls.length, 1);
        assert.equal($el._onCalls[0].event, 'success.hpopin');
        assert.equal($el._onCalls[0].handler, handler);
    });

    it('registers error handler from window when attribute is a bare identifier', function () {
        var handler = function () {};
        var $el = makeMockEl({ 'data-gina-popin-event-on-error': 'myErrorFn' });
        var win = { myErrorFn: handler };

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', win);
        });

        assert.equal(warns.length, 0);
        assert.equal($el._onCalls.length, 1);
        assert.equal($el._onCalls[0].event, 'error.hpopin');
        assert.equal($el._onCalls[0].handler, handler);
    });

    it('registers both handlers when both attributes are bare identifiers', function () {
        var ok = function () {};
        var ko = function () {};
        var $el = makeMockEl({
            'data-gina-popin-event-on-success': 'ok',
            'data-gina-popin-event-on-error':   'ko'
        });

        listenToXhrEventsReplica($el, 'popin', { ok: ok, ko: ko });

        assert.equal($el._onCalls.length, 2);
        assert.equal($el._onCalls[0].handler, ok);
        assert.equal($el._onCalls[1].handler, ko);
    });

    it('no-op (no registration, no warn) when neither attribute is present', function () {
        var $el = makeMockEl({});

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.equal(warns.length, 0);
        assert.equal($el._onCalls.length, 0);
    });

    it('threads the type through both attribute name AND event name', function () {
        var $el = makeMockEl({ 'data-gina-link-event-on-success': 'h' });
        var win = { h: function () {} };

        listenToXhrEventsReplica($el, 'link', win);

        assert.equal($el._onCalls[0].event, 'success.hlink');
    });
});


// --- 02 — events.js shape: function-call branch behavioural change (eval dropped) ---
describe('02 — events.js function-call branch dropped (#M21a)', function () {

    it('does NOT register a handler when success attribute is a function-call shape', function () {
        var $el = makeMockEl({ 'data-gina-popin-event-on-success': 'mySuccessFn(a, b)' });

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.equal($el._onCalls.length, 0, 'no $el.on call expected for function-call shape');
        assert.equal(warns.length, 1, 'expected one console.warn');
    });

    it('does NOT register a handler when error attribute is a function-call shape', function () {
        var $el = makeMockEl({ 'data-gina-popin-event-on-error': 'myErrorFn(err)' });

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.equal($el._onCalls.length, 0);
        assert.equal(warns.length, 1);
    });

    it('warn message carries the [gina-event] marker', function () {
        var $el = makeMockEl({ 'data-gina-popin-event-on-success': 'fn()' });

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.ok(/\[gina-event\]/.test(warns[0][0]), 'warn marker missing');
    });

    it('warn message includes the offending attribute value verbatim', function () {
        var attrValue = 'doStuff(form, "with quotes")';
        var $el = makeMockEl({ 'data-gina-popin-event-on-success': attrValue });

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.ok(warns[0][0].indexOf(attrValue) !== -1, 'attribute value missing from warn');
    });

    it('warn does not throw when console.warn is unavailable (try/catch)', function () {
        var $el = makeMockEl({ 'data-gina-popin-event-on-success': 'fn()' });
        var origWarn = console.warn;
        console.warn = function () { throw new Error('console.warn broken'); };

        try {
            assert.doesNotThrow(function () {
                listenToXhrEventsReplica($el, 'popin', {});
            });
        } finally {
            console.warn = origWarn;
        }
    });

    it('emits TWO warns when both attributes are function-call shape', function () {
        var $el = makeMockEl({
            'data-gina-popin-event-on-success': 'a()',
            'data-gina-popin-event-on-error':   'b()'
        });

        var warns = captureWarn(function () {
            listenToXhrEventsReplica($el, 'popin', {});
        });

        assert.equal(warns.length, 2);
        assert.equal($el._onCalls.length, 0);
    });
});


// --- 03 — validator/main.js shape: form bare-identifier branch parity ---
describe('03 — validator/main.js form bare-identifier branch (#M21a)', function () {

    it('registers success handler from window on a form-shaped element', function () {
        var handler = function () {};
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-success': 'onSubmit' });
        var win = { onSubmit: handler };

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, win);
        });

        assert.equal(warns.length, 0);
        assert.equal($form._onCalls.length, 1);
        assert.equal($form._onCalls[0].event, 'success.hform');
        assert.equal($form._onCalls[0].handler, handler);
    });

    it('registers error handler from window on a form-shaped element', function () {
        var handler = function () {};
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-error': 'onErr' });
        var win = { onErr: handler };

        listenToXhrFormEventsReplica($form, win);

        assert.equal($form._onCalls[0].event, 'error.hform');
        assert.equal($form._onCalls[0].handler, handler);
    });

    it('no-op when neither form attribute is present', function () {
        var $form = makeMockEl({});

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, {});
        });

        assert.equal(warns.length, 0);
        assert.equal($form._onCalls.length, 0);
    });

    it('registers both success and error handlers when both attributes are bare', function () {
        var ok = function () {};
        var ko = function () {};
        var $form = makeMockEl({
            'data-gina-form-event-on-submit-success': 'ok',
            'data-gina-form-event-on-submit-error':   'ko'
        });

        listenToXhrFormEventsReplica($form, { ok: ok, ko: ko });

        assert.equal($form._onCalls.length, 2);
    });
});


// --- 04 — validator/main.js shape: form function-call branch dropped ---
describe('04 — validator/main.js form function-call branch dropped (#M21a)', function () {

    it('does NOT register success handler when form attribute is a function-call shape', function () {
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-success': 'onSubmit(form, data)' });

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, {});
        });

        assert.equal($form._onCalls.length, 0);
        assert.equal(warns.length, 1);
    });

    it('does NOT register error handler when form attribute is a function-call shape', function () {
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-error': 'onErr(err)' });

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, {});
        });

        assert.equal($form._onCalls.length, 0);
        assert.equal(warns.length, 1);
    });

    it('warn message carries the [gina-form-event] marker', function () {
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-success': 'fn()' });

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, {});
        });

        assert.ok(/\[gina-form-event\]/.test(warns[0][0]), 'form warn marker missing');
    });

    it('warn message includes the offending attribute value verbatim', function () {
        var attrValue = 'submitHandler(formObj)';
        var $form = makeMockEl({ 'data-gina-form-event-on-submit-success': attrValue });

        var warns = captureWarn(function () {
            listenToXhrFormEventsReplica($form, {});
        });

        assert.ok(warns[0][0].indexOf(attrValue) !== -1);
    });
});


// --- 05 — source-inspection guards ---
describe('05 — #M21a source-inspection guards', function () {

    it('events.js: zero live eval(htmlSuccesEventCallback) calls remain', function () {
        var live = stripComments(EVENTS_SRC);
        assert.ok(
            !/eval\s*\(\s*htmlSuccesEventCallback\s*\)/.test(live),
            'live events.js still contains eval(htmlSuccesEventCallback)'
        );
    });

    it('events.js: zero live eval(htmlErrorEventCallback) calls remain', function () {
        var live = stripComments(EVENTS_SRC);
        assert.ok(
            !/eval\s*\(\s*htmlErrorEventCallback\s*\)/.test(live),
            'live events.js still contains eval(htmlErrorEventCallback)'
        );
    });

    it('events.js: console.warn shape present at both former eval sites', function () {
        // The replacement uses [gina-event] as the marker; assert two
        // occurrences (one per replaced site).
        var matches = EVENTS_SRC.match(/console\.warn\s*\(\s*['"]\[gina-event\]/g) || [];
        assert.ok(
            matches.length >= 2,
            'expected ≥2 [gina-event] console.warn calls in events.js, got ' + matches.length
        );
    });

    it('events.js: carries the #M21a provenance tag', function () {
        assert.ok(/#M21a/.test(EVENTS_SRC), '#M21a tag should be present in events.js');
    });

    it('main.js: zero live eval(htmlSuccesEventCallback) calls remain', function () {
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/eval\s*\(\s*htmlSuccesEventCallback\s*\)/.test(live),
            'live main.js still contains eval(htmlSuccesEventCallback)'
        );
    });

    it('main.js: zero live eval(htmlErrorEventCallback) calls remain', function () {
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/eval\s*\(\s*htmlErrorEventCallback\s*\)/.test(live),
            'live main.js still contains eval(htmlErrorEventCallback)'
        );
    });

    it('main.js: console.warn shape present at both former eval sites', function () {
        var matches = MAIN_SRC.match(/console\.warn\s*\(\s*['"]\[gina-form-event\]/g) || [];
        assert.ok(
            matches.length >= 2,
            'expected ≥2 [gina-form-event] console.warn calls in main.js, got ' + matches.length
        );
    });

    it('main.js: carries the #M21a provenance tag', function () {
        assert.ok(/#M21a/.test(MAIN_SRC), '#M21a tag should be present in main.js');
    });

    it('events.js: bare-identifier branch ($el.on(...)) preserved at both spots', function () {
        var successOn = /\$el\.on\s*\(\s*'success\.h'\s*\+\s*type\s*,\s*window\[htmlSuccesEventCallback\]\s*\)/.test(EVENTS_SRC);
        var errorOn   = /\$el\.on\s*\(\s*'error\.h'\s*\+\s*type\s*,\s*window\[htmlErrorEventCallback\]\s*\)/.test(EVENTS_SRC);
        assert.ok(successOn, 'success bare-identifier branch missing from events.js');
        assert.ok(errorOn,   'error bare-identifier branch missing from events.js');
    });

    it('main.js: bare-identifier branch ($form.on(...)) preserved at both spots', function () {
        var successOn = /\$form\.on\s*\(\s*'success\.hform'\s*,\s*window\[htmlSuccesEventCallback\]\s*\)/.test(MAIN_SRC);
        var errorOn   = /\$form\.on\s*\(\s*'error\.hform'\s*,\s*window\[htmlErrorEventCallback\]\s*\)/.test(MAIN_SRC);
        assert.ok(successOn, 'success bare-identifier branch missing from main.js');
        assert.ok(errorOn,   'error bare-identifier branch missing from main.js');
    });
});
