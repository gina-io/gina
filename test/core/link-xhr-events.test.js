'use strict';
// #B141 — link plugin HTML-callback forwarding (`data-gina-link-event-on-success` /
// `data-gina-link-event-on-error`) was dead, and carrying either attribute KILLED the
// link's XHR entirely. Three stacked layers:
//   1. scope — the only live `listenToXhrEvents` definition sat INSIDE `on()` in
//      utils/events.js (a brace slip: the "Nothing can be added after on()" comment
//      shows it was meant to follow on() as a top-level shim global like handleXhr),
//      so `linkRequest`'s call threw `ReferenceError: listenToXhrEvents is not defined`
//      BEFORE xhr.open — no request, no callback, click did nothing.
//   2. arity — the link call site passed one arg, so even a reachable definition read
//      `data-gina-undefined-event-on-*` and silently registered nothing.
//   3. plumbing — handleXhr fired the `.hlink` events named by the link INSTANCE id on
//      `document`, while registration binds the PER-LINK id on the anchor — the names
//      and targets could never match.
// Fix: the definition moved to top level in utils/events.js (shim global), the link
// call site passes `($link, 'link')`, and the six `.hlink` triggers in handleXhr use
// `$link.target` + `$link.id`. Browser-verified (2026-07-21) on a scaffolded bundle
// with a real render + real clicks (chromium): pre-fix the attribute-carrying link
// produced the ReferenceError and NO request while the attribute-less control link
// fetched normally; post-fix the success callback received the parsed JSON payload,
// the error callback received the 404 payload, zero page errors, and the served
// bundle hashed identical to the rebuilt dist.

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW = require('../fw');
var EVENTS_SRC = path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var LINK_SRC   = path.join(FW, 'core/asset/plugin/src/vendor/gina/link/main.js');
var DIST_JS    = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

var _cache = {};
function read(p) { return _cache[p] || (_cache[p] = fs.readFileSync(p, 'utf8')); }

var TWO_ARG_CALL  = "listenToXhrEvents($link, 'link')";
var ONE_ARG_CALL  = "listenToXhrEvents($link);";
var NEW_SUCCESS_TRIGGER = "triggerEvent(gina, $link.target, 'success.' + $link.id + '.hlink', result);";
var NEW_ERROR_TRIGGER   = "triggerEvent(gina, $link.target, 'error.' + $link.id + '.hlink', result);";
var OLD_SUCCESS_TRIGGER = "triggerEvent(gina, $target, 'success.' + id + '.hlink', result);";
var OLD_ERROR_TRIGGER   = "triggerEvent(gina, $target, 'error.' + id + '.hlink', result);";

function countOf(haystack, needle) {
    var c = 0, i = haystack.indexOf(needle);
    while (i > -1) { c++; i = haystack.indexOf(needle, i + needle.length); }
    return c;
}


// ── 01 — utils/events.js: the definition is a top-level shim global ───────────

describe('01 - link-xhr-events: listenToXhrEvents is a top-level global in events.js', function() {

    it('declares `function listenToXhrEvents($el, type)` at column 0 (top level)', function() {
        // a column-0 function declaration cannot be nested — this IS the scope invariant
        assert.match(read(EVENTS_SRC), /^function listenToXhrEvents\(\$el, type\) \{/m,
            'events.js must declare listenToXhrEvents as a top-level function');
    });

    it('the nested `var listenToXhrEvents` form is gone from events.js', function() {
        assert.equal(read(EVENTS_SRC).indexOf('var listenToXhrEvents'), -1,
            'the definition must not be a function-scoped var (it was swallowed inside on())');
    });

    it('the definition appears after on() closes (file order)', function() {
        var src = read(EVENTS_SRC);
        var onIdx  = src.search(/^function on\(event, cb\)/m);
        var defIdx = src.search(/^function listenToXhrEvents/m);
        assert.ok(onIdx > -1, 'on() declaration expected');
        assert.ok(defIdx > onIdx, 'listenToXhrEvents must be declared after on()');
    });

    it('handleXhr .hlink triggers use the per-link element and id (2 success + 5 error)', function() {
        var src = read(EVENTS_SRC);
        // 2 success sites since #B571: the shared success tail, and the popin branch — which
        // used to return before the tail, so a link answering into a popin never saw its
        // declared callback. Both address $link.target + $link.id.
        assert.equal(countOf(src, NEW_SUCCESS_TRIGGER), 2, 'retargeted success.hlink triggers: the shared tail + the popin branch (#B571)');
        assert.equal(countOf(src, NEW_ERROR_TRIGGER), 5, 'retargeted error.hlink triggers');
    });

    it('the instance-id-on-$target .hlink trigger shape is gone', function() {
        var src = read(EVENTS_SRC);
        assert.equal(src.indexOf(OLD_SUCCESS_TRIGGER), -1, 'old success.hlink trigger shape must be gone');
        assert.equal(src.indexOf(OLD_ERROR_TRIGGER), -1, 'old error.hlink trigger shape must be gone');
    });

    it('the .hform triggers still address $target + id (forms path untouched)', function() {
        var src = read(EVENTS_SRC);
        assert.equal(countOf(src, "triggerEvent(gina, $target, 'success.' + id + '.hform', result);"), 1);
        assert.equal(countOf(src, "triggerEvent(gina, $target, 'error.' + id + '.hform', result);"), 5);
    });
});


// ── 02 — link/main.js: the call site passes the type, the stale copy is gone ──

describe('02 - link-xhr-events: link/main.js registration call', function() {

    it("calls listenToXhrEvents($link, 'link') — two args", function() {
        assert.equal(countOf(read(LINK_SRC), TWO_ARG_CALL), 1,
            'linkRequest must pass the link type to listenToXhrEvents');
    });

    it('the one-arg call is gone', function() {
        assert.equal(read(LINK_SRC).indexOf(ONE_ARG_CALL), -1,
            'the one-arg call read data-gina-undefined-event-on-* and registered nothing');
    });

    it('the stale commented-out local definition is gone', function() {
        assert.equal(read(LINK_SRC).indexOf('// var listenToXhrEvents'), -1,
            'the dead commented-out local copy must be removed (it hid the scope defect)');
    });
});


// ── 03 — dist fidelity: the shipped bundle carries the same shape ─────────────

describe('03 - link-xhr-events: dist bundle fidelity', function() {

    it('dist declares the top-level definition and the two-arg call', function() {
        var dist = read(DIST_JS);
        assert.match(dist, /^function listenToXhrEvents\(\$el, type\) \{/m,
            'dist must carry the top-level definition');
        assert.equal(countOf(dist, TWO_ARG_CALL), 1, 'dist must carry the two-arg call');
        assert.equal(dist.indexOf(ONE_ARG_CALL), -1, 'dist must not carry the one-arg call');
    });

    it('dist carries the retargeted .hlink triggers and none of the old shape', function() {
        var dist = read(DIST_JS);
        assert.equal(countOf(dist, NEW_SUCCESS_TRIGGER), 2, 'the shared tail + the popin branch (#B571)');
        assert.equal(countOf(dist, NEW_ERROR_TRIGGER), 5);
        assert.equal(dist.indexOf(OLD_SUCCESS_TRIGGER), -1);
        assert.equal(dist.indexOf(OLD_ERROR_TRIGGER), -1);
    });

    it('the events.js segment of dist has no nested var form (validator’s own ($form) def is the sanctioned exception later in the bundle)', function() {
        var dist = read(DIST_JS);
        var eventsEnd = dist.indexOf('define("utils/events"');
        assert.ok(eventsEnd > -1, 'utils/events synthetic define expected in dist');
        var segment = dist.slice(0, eventsEnd);
        // scope the negative pin to the events.js segment: the validator plugin keeps its
        // OWN form-only `var listenToXhrEvents = function($form)` later in the bundle —
        // that one is function-scoped inside ValidatorPlugin by design and must stay.
        assert.equal(segment.indexOf('var listenToXhrEvents = function($el, type)'), -1,
            'the events.js segment must not keep the nested var definition');
    });
});


// ── 04 — behaviour: the REAL definition, extracted from events.js ─────────────

function extractRealDef() {
    var src = read(EVENTS_SRC);
    var m = src.match(/^function listenToXhrEvents\(\$el, type\) \{[\s\S]*?\n\}/m);
    assert.ok(m, 'could not extract the real listenToXhrEvents definition');
    return m[0];
}

function makeEl(attrs) {
    var onCalls = [];
    return {
        _onCalls: onCalls,
        target: { getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; } },
        on: function (event, cb) { onCalls.push({ event: event, cb: cb }); return this; }
    };
}

function runRealDef($el, type, windowLike) {
    var warns = [];
    var consoleLike = { warn: function () { warns.push(Array.prototype.slice.call(arguments)); } };
    /* eslint-disable no-new-func */
    var fn = new Function('window', 'console', extractRealDef() + '\nreturn listenToXhrEvents;')(windowLike, consoleLike);
    fn($el, type);
    return { onCalls: $el._onCalls, warns: warns };
}

describe('04 - link-xhr-events: real-definition behaviour', function() {

    it("registers window callbacks on success.hlink / error.hlink for type 'link'", function() {
        var ok = function () {}, ko = function () {};
        var $el = makeEl({
            'data-gina-link-event-on-success': 'myOk',
            'data-gina-link-event-on-error': 'myKo'
        });
        var r = runRealDef($el, 'link', { myOk: ok, myKo: ko });
        assert.equal(r.onCalls.length, 2);
        assert.equal(r.onCalls[0].event, 'success.hlink');
        assert.equal(r.onCalls[0].cb, ok);
        assert.equal(r.onCalls[1].event, 'error.hlink');
        assert.equal(r.onCalls[1].cb, ko);
        assert.equal(r.warns.length, 0);
    });

    it('registers nothing when the attributes are absent', function() {
        var r = runRealDef(makeEl({}), 'link', {});
        assert.equal(r.onCalls.length, 0);
        assert.equal(r.warns.length, 0);
    });

    it('refuses the function-call shape with a warning (#M21a preserved through the move)', function() {
        var $el = makeEl({ 'data-gina-link-event-on-success': 'doStuff(a)' });
        var r = runRealDef($el, 'link', {});
        assert.equal(r.onCalls.length, 0);
        assert.equal(r.warns.length, 1);
        assert.match(String(r.warns[0][0]), /\[gina-event\]/);
    });

    it('SUBTRACT (pre-fix arity): the one-arg call registers nothing despite the attributes', function() {
        // the pre-fix link call site passed no type, so the REAL definition looked up
        // `data-gina-undefined-event-on-*` — proving the two-arg fix is load-bearing
        var $el = makeEl({
            'data-gina-link-event-on-success': 'myOk',
            'data-gina-link-event-on-error': 'myKo'
        });
        var r = runRealDef($el, undefined, { myOk: function () {}, myKo: function () {} });
        assert.equal(r.onCalls.length, 0, 'type=undefined must register nothing');
    });
});


// ── 05 — alignment: registration channel matches the retargeted trigger ───────

describe('05 - link-xhr-events: registration/trigger alignment', function() {

    // on() maps a `.hlink`-suffixed channel to '<event>.<this.id>.hlink' and listens on
    // this.target — replicated here byte-for-byte from events.js:on() (the sed-style
    // transform is a single replace call in the source, pinned in §01).
    function onChannelToEventName(channel, id) {
        return channel.replace(/\.hlink$/, '.' + id + '.hlink');
    }

    it('the per-link trigger name and target match the registration', function() {
        var $link = { id: 'link.click.gina-link-instance-1-uuid', target: { anchor: true } };
        var registeredName = onChannelToEventName('success.hlink', $link.id);
        var triggeredName  = 'success.' + $link.id + '.hlink'; // the retargeted trigger shape (§01 pins it)
        assert.equal(registeredName, triggeredName, 'names must match for the callback to fire');
        // both sides address $link.target (registration listens on it, trigger dispatches on it)
    });

    it('SUBTRACT (pre-fix plumbing): the instance-id-on-document trigger could never match', function() {
        var $link = { id: 'link.click.gina-link-instance-1-uuid', target: { anchor: true } };
        var instance = { id: 'gina-links-instance-uuid', target: { theDocument: true } };
        var registeredName = onChannelToEventName('success.hlink', $link.id);
        var preFixTriggeredName = 'success.' + instance.id + '.hlink'; // the old trigger shape
        assert.notEqual(registeredName, preFixTriggeredName, 'pre-fix names never matched');
        assert.notEqual($link.target, instance.target, 'pre-fix dispatch target was not the listener target');
    });
});
