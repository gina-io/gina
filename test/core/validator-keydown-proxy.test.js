'use strict';
/**
 * FormValidator - the form-level keydown proxy defers the native-cancel
 * decision to the namespaced handler (#B444, gh issue #67).
 *
 * `addListener(gina, $el, 'keydown.<id>', fn)` registers fn for a CUSTOM event
 * type a native keydown can never fire; the form-level `keydownProxyHandler`
 * bridges the two by re-dispatching every native keydown whose target has a
 * registered namespaced handler. Pre-fix it called `cancelEvent(event)` on the
 * NATIVE event BEFORE that dispatch - unconditionally. preventDefault on a
 * native keydown suppresses the browser's own editing command, so on a
 * real-Safari UA (where handleAutoComplete registered exactly such a handler, until #B1055)
 * EVERY modifier chord on a live-checked autocomplete-suppressed field was
 * dead: paste, select-all, copy, cut, undo - with no paste/beforeinput event
 * observable anywhere, because the command was cancelled at the keydown.
 * The interception handler's own #B134 chord bail (return before
 * preventDefault) was correct and could not help: the proxy had already
 * cancelled the native event one layer up - a component-level contract
 * defeated by the choreography above it.
 *
 * The fix inverts the proxy's contract: dispatch the synthetic event FIRST,
 * then cancel the native keydown only if the handler preventDefault'ed the
 * synthetic one. The interception handler already prevents on the paths it
 * re-implements (printable keys, Delete, Backspace...) and already does not on
 * modifier chords, so no handler change was needed. `triggerEvent` hands the
 * dispatched event back to make that decision readable.
 *
 * Mechanism + fix were measured live on WebKit (headless, real clipboard):
 * pre-fix paste and Cmd+A dead on the shimmed field with a firing clipboard
 * control; post-fix both alive, typing interception intact, the #B389
 * fast-caret scene unchanged. The committed WebKit lock is
 * test/e2e/validator-autocomplete-paste.spec.js (cross-engine job);
 * this file is the per-push gate on the shapes.
 *
 * Layering: source pins (comment-stripped - the fix's own `was:` record names
 * the retired call shape) + extracted-real-bytes execution of BOTH changed
 * functions + dist pins. Red-first validated against `git show HEAD:` copies:
 * the order arm, the chord arm and the triggerEvent-return arm all fail on the
 * pre-fix bytes.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW            = require(path.join(__dirname, '..', 'fw'));
var MAIN_PATH     = path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'main.js');
var EVENTS_PATH   = path.join(FW, 'core', 'asset', 'plugin', 'src', 'vendor', 'gina', 'utils', 'events.js');
var DIST_JS_PATH  = path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js', 'gina.js');
var DIST_MIN_PATH = path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js', 'gina.min.js');

var mainSrc   = fs.readFileSync(MAIN_PATH, 'utf8');
var eventsSrc = fs.readFileSync(EVENTS_PATH, 'utf8');

/** Strips line comments so negative pins never trip on the `was:` record. @inner */
function stripComments(src) {
    return src.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

/**
 * Terminator-anchored slice of a function expression; both anchors are
 * uniqueness-guarded (a brace walk is not used - see the route.request
 * precedent for why anchors are the safer default here).
 * @inner
 */
function slice(src, decl, term, label) {
    if (src.split(decl).length !== 2) { throw new Error(label + ': DECL count ' + (src.split(decl).length - 1)); }
    if (src.split(term).length !== 2) { throw new Error(label + ': TERM count ' + (src.split(term).length - 1)); }
    var i = src.indexOf(decl), j = src.indexOf(term);
    if (j < i) { throw new Error(label + ': TERM precedes DECL'); }
    return src.substring(i, j);
}

// ── the proxy handler, extracted and compiled with its free variables injected
var PROXY_DECL = 'var keydownProxyHandler = function(event) {';
var PROXY_TERM = 'var keyupProxyHandler = function(event) {';
function compileProxy(src) {
    var body = slice(src, PROXY_DECL, PROXY_TERM, 'proxy');
    // the slice ends just before the keyup declaration; close over the trailing whitespace
    return new Function(
        'releaseAnswerFocusHold', 'keyboardMapping', 'gina', 'cancelEvent', 'triggerEvent',
        body + '\n return keydownProxyHandler;'
    );
}

/** One drive of the extracted proxy against a scripted triggerEvent. @inner */
function driveProxy(src, opts) {
    var calls = [];
    var factory = compileProxy(src);
    var handler = factory(
        function () { calls.push(['releaseHold']); },
        {},
        { events: opts.registered ? { 'keydown.f1': 'f1' } : {} },
        function (e) { calls.push(['cancelEvent', e]); },
        function (t, el, name, args, ev) { calls.push(['triggerEvent', name]); return opts.syntheticReturn; }
    );
    var nativeEvent = {
        target: { id: opts.id !== undefined ? opts.id : 'f1' },
        type: 'keydown', keyCode: 86,
        defaultPrevented: !!opts.prePrevented,
        detail: null
    };
    var ret = handler(nativeEvent);
    return { calls: calls, ret: ret, nativeEvent: nativeEvent };
}

// ── triggerEvent, extracted from events.js and driven with a fake window ────
var TRIG_DECL = 'function triggerEvent (target, element, name, args, proxiedEvent) {';
var TRIG_TERM = 'function cancelEvent(event) {';
function driveTriggerEvent(src, handlerPrevents) {
    var body = slice(src, TRIG_DECL, TRIG_TERM, 'triggerEvent');
    function FakeCustomEvent(name, init) {
        this.type = name; this.detail = init.detail;
        this.bubbles = init.bubbles; this.cancelable = init.cancelable;
        this.defaultPrevented = false;
    }
    FakeCustomEvent.prototype.preventDefault = function () { this.defaultPrevented = true; };
    var received = null;
    var element = {
        id: 'f1',
        dispatchEvent: function (e) {
            received = e;
            if (handlerPrevents) { e.preventDefault(); }
            return !e.defaultPrevented;
        }
    };
    var fn = new Function(
        'window', 'document', 'mergeEventProps', 'target',
        body + '\n return triggerEvent;'
    )({ CustomEvent: FakeCustomEvent }, {}, function (evt) { return evt; }, {});
    var ret = fn({}, element, 'keydown.f1', null, null);
    return { ret: ret, received: received };
}


// ─── 01 - source pins ────────────────────────────────────────────────────────
describe('01 - source pins: the proxy defers the cancel; triggerEvent returns the event (#B444)', function () {
    var code = stripComments(mainSrc);
    var evCode = stripComments(eventsSrc);

    it('anti-vacuity: both stripped corpora still carry their subjects', function () {
        assert.ok(code.indexOf(PROXY_DECL) > -1, 'proxy declaration survived the strip');
        assert.ok(evCode.indexOf(TRIG_DECL) > -1, 'triggerEvent declaration survived the strip');
    });

    it('the proxy no longer cancels unconditionally before the dispatch', function () {
        var region = stripComments(slice(mainSrc, PROXY_DECL, PROXY_TERM, 'proxy'));
        var cancelIdx  = region.indexOf('cancelEvent(event)');
        var triggerIdx = region.indexOf('triggerEvent(gina, $el, _evt, event.detail, event)');
        assert.ok(cancelIdx > -1 && triggerIdx > -1, 'both calls are still present');
        assert.ok(triggerIdx < cancelIdx, 'the dispatch must run before the cancel decision');
        assert.ok(/_syntheticEvt\s*&&\s*_syntheticEvt\.defaultPrevented/.test(region),
            'the cancel must be gated on the synthetic event having been prevented');
    });

    it('triggerEvent hands the dispatched event back on both element paths', function () {
        var region = stripComments(slice(eventsSrc, TRIG_DECL, TRIG_TERM, 'triggerEvent'));
        assert.equal(region.split('return evt;').length - 1, 2,
            'the CustomEvent branch and the fireEvent branch each return the event');
    });
});


// ─── 02 - extraction controls ────────────────────────────────────────────────
describe('02 - extraction controls (#B444)', function () {
    it('all four anchors are unique in their corpora', function () {
        assert.equal(mainSrc.split(PROXY_DECL).length - 1, 1);
        assert.equal(mainSrc.split(PROXY_TERM).length - 1, 1);
        assert.equal(eventsSrc.split(TRIG_DECL).length - 1, 1);
        assert.equal(eventsSrc.split(TRIG_TERM).length - 1, 1);
    });

    it('both extractions compile and are callable', function () {
        assert.equal(typeof compileProxy(mainSrc)(function(){}, {}, {events:{}}, function(){}, function(){}), 'function');
        var t = driveTriggerEvent(eventsSrc, false);
        assert.ok(t.received, 'triggerEvent dispatched to the fake element');
    });
});


// ─── 03 - behaviour: the extracted real bytes ────────────────────────────────
describe('03 - proxy behaviour: the handler decides the native cancel (#B444)', function () {

    it('chord shape: handler does NOT prevent -> the native keydown is NOT cancelled', function () {
        // The load-bearing arm: pre-fix the proxy cancelled before asking.
        var d = driveProxy(mainSrc, { registered: true, syntheticReturn: { defaultPrevented: false } });
        var names = d.calls.map(function (c) { return c[0]; });
        assert.ok(names.indexOf('triggerEvent') > -1, 'the namespaced dispatch ran');
        assert.equal(names.indexOf('cancelEvent'), -1,
            'a chord the handler let through must reach the browser un-prevented');
    });

    it('intercepted shape: handler prevents -> the native keydown IS cancelled, after the dispatch', function () {
        var d = driveProxy(mainSrc, { registered: true, syntheticReturn: { defaultPrevented: true } });
        var names = d.calls.map(function (c) { return c[0]; });
        assert.ok(names.indexOf('cancelEvent') > -1, 'the interception path still suppresses the native default');
        assert.ok(names.indexOf('triggerEvent') < names.indexOf('cancelEvent'),
            'the dispatch must precede the cancel - the decision is the handler\'s');
        assert.equal(d.calls[names.indexOf('cancelEvent')][1], d.nativeEvent,
            'the cancel lands on the native event being proxied');
    });

    it('a triggerEvent yielding nothing fails OPEN to native behaviour', function () {
        // The customEvent (element-less) path returns undefined; the safe
        // direction for an unreadable decision is to leave the browser alone.
        var d = driveProxy(mainSrc, { registered: true, syntheticReturn: undefined });
        assert.equal(d.calls.map(function (c) { return c[0]; }).indexOf('cancelEvent'), -1);
    });

    it('unregistered target: neither dispatch nor cancel', function () {
        var d = driveProxy(mainSrc, { registered: false, syntheticReturn: { defaultPrevented: true } });
        var names = d.calls.map(function (c) { return c[0]; });
        assert.equal(names.indexOf('triggerEvent'), -1);
        assert.equal(names.indexOf('cancelEvent'), -1);
    });

    it('existing contract preserved: id-less target and pre-prevented native event both bail', function () {
        var d1 = driveProxy(mainSrc, { registered: true, id: '', syntheticReturn: { defaultPrevented: true } });
        assert.equal(d1.ret, false, 'id-less target returns false');
        var d2 = driveProxy(mainSrc, { registered: true, prePrevented: true, syntheticReturn: { defaultPrevented: true } });
        assert.equal(d2.ret, false, 'an already-prevented native event returns false');
        assert.equal(d2.calls.map(function (c) { return c[0]; }).indexOf('triggerEvent'), -1,
            'and is not re-dispatched');
    });

    it('triggerEvent returns the very event it dispatched, carrying the handler\'s decision', function () {
        var yes = driveTriggerEvent(eventsSrc, true);
        assert.equal(yes.ret, yes.received, 'identity: the returned object is the dispatched one');
        assert.equal(yes.ret.defaultPrevented, true);
        var no = driveTriggerEvent(eventsSrc, false);
        assert.equal(no.ret, no.received);
        assert.equal(no.ret.defaultPrevented, false);
    });
});


// ─── 04 - dist pins ──────────────────────────────────────────────────────────
describe('04 - dist pins: the browser bundle carries the deferral (#B444)', function () {
    var distSrc = fs.readFileSync(DIST_JS_PATH, 'utf8');
    var distMin = fs.readFileSync(DIST_MIN_PATH, 'utf8');

    it('the unminified bundle carries the gated cancel verbatim', function () {
        var code = stripComments(distSrc);
        assert.ok(/_syntheticEvt\s*&&\s*_syntheticEvt\.defaultPrevented/.test(code),
            'the deferral gate is in gina.js');
        // scope the count to the bundled triggerEvent region - the whole
        // bundle carries an unrelated `return evt;` from another module, so a
        // corpus-wide count would miscount (measured: 3 bundle-wide)
        var region = stripComments(slice(distSrc, TRIG_DECL, TRIG_TERM, 'dist triggerEvent'));
        assert.equal(region.split('return evt;').length - 1, 2,
            'both triggerEvent returns are in the bundled copy');
    });

    it('the minified bundle gates the cancel on the returned event (derived post-rebuild)', function () {
        // Derived from the emitted artifact after the prod rebuild (Closure
        // coalesced the temp into a reused local and chained the whole guard);
        // validated 0-pre / 1-post against the previous commit's gina.min.js.
        var pos = distMin.match(/\(\s*(\w+)\s*=\s*triggerEvent\([^)]*\)\s*\)\s*&&\s*\1\.defaultPrevented\s*&&\s*cancelEvent\(/g) || [];
        assert.equal(pos.length, 1, 'the deferral chain must be in gina.min.js exactly once');
        // untouched-neighbour control: the keyup proxy keeps the pre-fix
        // comma shape, so the corpus can still express the OLD encoding -
        // the positive above is not matching by accident of a global reshape.
        var old = distMin.match(/cancelEvent\(\s*(\w+)\s*\)\s*,\s*triggerEvent\(/g) || [];
        assert.ok(old.length >= 1, 'the keyup proxy still carries the retired shape (control)');
    });
});
