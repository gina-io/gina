'use strict';
/**
 * #B585 — `unbindForm` detaches what `bindForm` attached; `destroy()` detaches consumer handlers too.
 *
 * Before the fix `unbindForm` detached nothing but the reassociated-control proxies: its nine
 * form-level `removeListener` calls passed the validator's RECORD (no `removeEventListener` on it)
 * and every per-element call omitted the handler, so only `gina.events` keys were deleted — and
 * `bindForm` then re-attached every listener over the copies still on the node (1 → 3 after two
 * `reBind()`, measured on the e2e scene). The behaviour is driven end-to-end on the real bundle by
 * `test/e2e/validator-rebind-listeners-b585.spec.js`; this file pins the STRUCTURE it depends on:
 *
 *  - `bindForm` records every listener it attaches on `$form.boundListeners` by wrapping the
 *    `addListener` call in the push (`addListener` returns the attached callback), so each existing
 *    call keeps its own text — the harnesses that extract and execute those functions with a stubbed
 *    `addListener` keep working, and no new free identifier enters them;
 *  - `unbindForm` drains that ledger by reference, releases the registry keys the binding wrote,
 *    clears the `registered.<id>` live-check flags, and no longer walks the subtree guessing names
 *    (that walk also deleted the keys of controls owned by OTHER forms);
 *  - `on()` records the wrapper it attaches on the handle (`consumerListeners`); `unbindForm` leaves
 *    those alone (a `.on()` handler and the declarative `.hform` hooks outlive a `reBind()`) and
 *    `destroy()` removes them AFTER firing `destroy.<id>`;
 *  - the two by-catches fixed with it: the browser's own `addEventListener` is no longer called with
 *    gina's 4-argument shape, and the dead 4-argument `removeListener(gina, $form, evt, proceed)`
 *    guard is gone; `removeListener`'s 4th parameter keeps its completion-callback contract;
 *  - the built bundles carry the change (dist pins: RED before the rebuild, green after).
 *
 * Red-first: `GINA_B585_MAIN=<file>` / `GINA_B585_EVENTS=<file>` point the source pins at another
 * copy of the two sources, e.g. `git show HEAD:<path>` before the change — every source pin must
 * fail there, and the extract-and-execute arms must fail to extract.
 *
 * Usage: node --test test/core/validator-unbind-ledger-b585.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B585_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var EVENTS   = process.env.GINA_B585_EVENTS || path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC, EVT;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
    EVT = fs.readFileSync(EVENTS, 'utf8');
});

/**
 * Strips block comments then whole-line comments, so negative pins do not trip on prose.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/mg, '');
}

/**
 * Extracts a `var <name> = function (...) {...}` (or `function <name>(...) {...}`) expression by
 * brace-walking from its declaration, after checking the declaration occurs exactly once.
 *
 * @param {string} src
 * @param {string} declaration - the exact declaration prefix
 * @returns {string} the function text, `function` through its closing brace
 */
function extractFunctionExpression(src, declaration) {
    var declIdx = src.indexOf(declaration);
    assert.ok(declIdx >= 0, 'declaration not found: ' + declaration);
    assert.equal(src.indexOf(declaration, declIdx + 1), -1, 'declaration must occur exactly once: ' + declaration);
    var fnStart = src.indexOf('function', declIdx);
    var braceIdx = src.indexOf('{', fnStart);
    var depth = 0;
    for (var i = braceIdx, len = src.length; i < len; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return src.substring(fnStart, i + 1);
            }
        }
    }
    assert.fail('unbalanced braces walking ' + declaration);
}

/**
 * Occurrence count that is safe on minified single-line files.
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    return hay.split(needle).length - 1;
}

/**
 * Occurrences of a global regex.
 *
 * @param {string} hay
 * @param {RegExp} re - must carry the `g` flag
 * @returns {number}
 */
function countRe(hay, re) {
    return (hay.match(re) || []).length;
}

/** The push prefix sits on its own line above the untouched `addListener(` line. */
function pushed(ledger, el, evt, call) {
    return new RegExp(ledger.replace(/\$/g, '\\$').replace(/\./g, '\\.') + '\\.push\\(\\{ el: ' + el + ', evt: ' + evt + ', fn:\\n\\s*' + call, 'g');
}

/** A spy element: records removeEventListener calls, answers getAttribute('id'). */
function spyEl(id, elements) {
    var el = {
        id: id,
        removed: [],
        elements: elements || [],
        getAttribute: function (k) { return (k === 'id') ? id : null; },
        removeEventListener: function (evt, fn, capture) { el.removed.push([evt, fn, capture]); }
    };
    return el;
}

// ============================================================================
// §01 — bindForm records what it attaches, by wrapping each addListener call
// ============================================================================
describe('#B585 §01 — bindForm ledgers every listener it attaches', function () {

    var bindForm, active;
    before(function () {
        // the brace-walk cannot balance a 2,700-line function; slice to the file's own terminator
        var a = SRC.indexOf('var bindForm = function($target, customRule) {');
        var b = SRC.indexOf('} // EO bindForm()');
        assert.ok(a > -1 && b > a, 'bindForm and its EO marker, in order');
        assert.equal(SRC.indexOf('} // EO bindForm()', b + 1), -1, 'one terminator');
        bindForm = SRC.substring(a, b);
        active   = stripComments(bindForm);
    });

    it('01.1 - the ledger is initialised at bind entry, beside the reassociated side-table', function () {
        assert.ok(active.indexOf('$form.boundListeners = [];') > -1, 'the ledger must be created on the record');
        assert.ok(active.indexOf('$form.boundListeners = [];') < active.indexOf('var getOwnedElements = function'),
            'created before any control is collected');
    });

    it('01.2 - the eight form-level proxies, the native submit proxy, reset.<id> and validate.<id> are ledgered', function () {
        ['reset', 'keydown', 'keyup', 'focusin', 'focusout', 'change', 'click', 'animationstart'].forEach(function (type) {
            var handler = type.replace('animationstart', 'autofill') + 'ProxyHandler';
            assert.equal(countRe(active, pushed('$form.boundListeners', '\\$target', "'" + type + "'", "addListener\\(gina, \\$target, '" + type + "', " + handler + "\\) \\}\\);")), 1,
                'form-level proxy not ledgered: ' + type);
        });
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$target', 'subEvent', 'addListener\\(gina, \\$target, subEvent, function\\(e\\) \\{')), 1, 'reset.<id>');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$target', 'evt', 'addListener\\(gina, \\$target, evt, function\\(event\\) \\{')), 1, 'validate.<id>');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$target', 'evt', 'addListener\\(gina, \\$target, evt, function\\(e\\) \\{')), 1, 'the native submit proxy');
    });

    it('01.3 - the submit trigger\'s own listeners, the select, file, checkbox and radio relays are ledgered', function () {
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$submit', 'evt', 'addListener\\(gina, \\$submit, evt, function\\(event\\) \\{')), 1, 'submit.<trigger>');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$submit', "'click'", "addListener\\(gina, \\$submit, 'click', function\\(e\\) \\{ e\\.preventDefault\\(\\); \\}\\) \\}\\);")), 1, 'the preventDefault click');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$select\\[s\\]', "'change'", "addListener\\(gina, \\$select\\[s\\], 'change', function\\(event\\) \\{")), 1, 'select change');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$inputs\\[f\\]', "'change'", "addListener\\(gina, \\$inputs\\[f\\], 'change', function\\(event\\) \\{")), 1, 'file change');
        assert.equal(countRe(active, pushed('$form.boundListeners', '\\$el', 'evt', 'addListener\\(gina, \\$el, evt, function\\(event\\) \\{')), 2, 'the checkbox and radio relays');
    });

    it('01.4 - inside bindForm, the only bare addListener calls left are the seven reassociated-control proxies (their own side-table keeps the refs)', function () {
        var total   = countRe(active, /addListener\(gina,/g);
        var wrapped = countRe(active, /fn:\n\s*addListener\(gina,/g);
        assert.equal(total - wrapped, 7, 'bare addListener calls inside bindForm: ' + (total - wrapped) + ' (total ' + total + ', ledgered ' + wrapped + ')');
        assert.equal(count(active, 'addListener(gina, $rEl,'), 7, 'the seven reassociated proxies are the bare ones');
    });

    it('01.5 - the dead 4-argument guard is gone: nothing passes a 4th argument to removeListener', function () {
        assert.equal(stripComments(SRC).indexOf('removeListener(gina, $form, evt, proceed)'), -1);
        assert.equal(active.indexOf("gina.events[evt] == 'validate.' + _id"), -1, 'the guard that compared an id to a name');
    });
});

// ============================================================================
// §02 — the live-check and autocomplete attachments outside bindForm
// ============================================================================
describe('#B585 §02 — addLiveForInput and handleAutoComplete ledger their attachments', function () {

    it('02.1 - addLiveForInput ledgers its eventsList handler on the form it was given, after making sure the ledger exists', function () {
        var fn = stripComments(extractFunctionExpression(SRC, 'var addLiveForInput = function($form, $el, liveCheckTimer, isOtherTagAllowed) {'));
        var init = fn.indexOf('if ( !Array.isArray($form.boundListeners) ) { $form.boundListeners = []; }');
        var push = fn.search(pushed('$form.boundListeners', '\\$el', 'eventsList', 'addListener\\(gina, \\$el, eventsList, function\\(event\\) \\{'));
        assert.ok(init > -1, 'the ledger is created when the harness hands a bare record');
        assert.ok(push > init, 'the push wraps the existing addListener call');
    });

    it('02.2 - the browser\'s own addEventListener is no longer called with gina\'s shape (by-catch, main.js:7042)', function () {
        assert.equal(stripComments(SRC).indexOf('addEventListener(gina,'), -1);
    });

    it('02.3 - handleAutoComplete resolves the owner form tolerantly and ledgers its three handlers', function () {
        var fn = stripComments(extractFunctionExpression(SRC, 'var handleAutoComplete = function($el, liveCheckTimer) {'));
        assert.ok(fn.indexOf("typeof(instance) != 'undefined'") > -1, 'a harness without `instance` must still run the handler');
        assert.equal(countRe(fn, pushed('ledger', '\\$el', "'focusout\\.'\\+ \\$el\\.id", "addListener\\(gina, \\$el, 'focusout\\.'\\+ \\$el\\.id, function\\(event\\) \\{")), 1);
        assert.equal(countRe(fn, pushed('ledger', '\\$el', "'focusin\\.'\\+ \\$el\\.id", "addListener\\(gina, \\$el, 'focusin\\.'\\+ \\$el\\.id, function\\(event\\) \\{")), 1);
        assert.equal(countRe(fn, pushed('ledger', 'event\\.currentTarget', 'evtName', 'addListener\\(gina, event\\.currentTarget, evtName, function\\(e\\) \\{')), 1);
    });

    it('02.4 - the lazy keydown add-once guard asks the ledger when the owner form is known, the registry key only as the fallback', function () {
        var fn = stripComments(extractFunctionExpression(SRC, 'var handleAutoComplete = function($el, liveCheckTimer) {'));
        assert.ok(fn.indexOf("if ( ( $ownerForm ) ? !isKeydownBound : typeof(gina.events[evtName]) == 'undefined' ) {") > -1);
    });
});

// ============================================================================
// §03 — unbindForm drains the ledger by reference and nothing else
// ============================================================================
describe('#B585 §03 — unbindForm', function () {

    var unbind, active;
    before(function () {
        unbind = extractFunctionExpression(SRC, 'var unbindForm = function($target) {');
        active = stripComments(unbind);
    });

    it('03.1 - the ledger drain precedes the reassociated drain, both end with an emptied table', function () {
        var ledger = active.indexOf('Array.isArray($form.boundListeners)');
        var reset  = active.indexOf('$form.boundListeners = [];');
        var reasso = active.indexOf('Array.isArray($form.reassociatedListeners)');
        assert.ok(ledger > -1 && reset > ledger && reasso > reset, 'ledger drain, then its reset, then the reassociated drain');
        assert.ok(active.indexOf('entry.el.removeEventListener(') > -1);
    });

    it('03.2 - a released key is deleted only when the binding wrote it (the registry stores the last writer\'s id)', function () {
        assert.ok(active.indexOf('gina.events[evts[e]] == eId') > -1);
    });

    it('03.3 - the live-check registration flags of every owned control are cleared', function () {
        assert.ok(active.indexOf("delete gina.events['registered.' + ownedId];") > -1);
        assert.ok(active.indexOf('$form.target.elements') > -1, 'owner-aware: reassociated controls and FACEs included');
    });

    it('03.4 - the subtree walk and the nine record-path deletions are gone', function () {
        assert.equal(active.indexOf("getElementsByTagName('button')"), -1, 'no name-guessing walk');
        assert.equal(active.indexOf("removeListener(gina, $form, 'success.' + _id);"), -1, 'a consumer key survives a reBind()');
        assert.equal(active.indexOf("removeListener(gina, $form, 'validate.' + _id);"), -1, 'the record-path deletion (the record has no removeEventListener)');
        assert.equal(active.indexOf('removeListener('), -1, 'unbindForm no longer calls removeListener at all');
    });

    it('03.5 - the pending staged-upload wait is still dropped before the form is marked unbound (#B726)', function () {
        var clear   = unbind.indexOf('$form.stagedUploadWait = null;');
        var unbound = unbind.indexOf('$form.binded = false;');
        assert.ok(clear > -1 && unbound > clear);
    });

    it('03.6 - executed on spy elements: detaches by reference, releases the binding\'s keys, keeps a consumer key, clears the flags', function () {
        var fieldEl = spyEl('ref');
        var formEl  = spyEl('f', [ fieldEl ]);
        var fnA = function () {}, fnB = function () {}, fnC = function () {};
        var gina = { events: {
            'keydown': 'f', 'validate.f': 'f', 'change.ref': 'ref', 'keyup.ref': 'ref',
            'registered.ref': 'ref', 'success.f': 'f', 'click': 'other-el'
        } };
        var $form = {
            binded: true, target: formEl, stagedUploadWait: { pending: true },
            boundListeners: [
                { el: formEl,  evt: 'keydown',                   fn: fnA },
                { el: formEl,  evt: 'validate.f',                fn: fnB },
                { el: fieldEl, evt: ['change.ref', 'keyup.ref'], fn: fnC },
                { el: formEl,  evt: 'click',                     fn: fnA }
            ],
            reassociatedListeners: []
        };
        var instance = { $forms: { f: $form } };
        var fn = new Function('instance', 'gina', 'return (' + unbind + ');')(instance, gina);

        var out = fn($form);

        assert.equal(out, $form);
        assert.deepEqual(formEl.removed, [ ['keydown', fnA, false], ['validate.f', fnB, false], ['click', fnA, false] ]);
        assert.deepEqual(fieldEl.removed, [ ['change.ref', fnC, false], ['keyup.ref', fnC, false] ]);
        assert.deepEqual(Object.keys(gina.events).sort(), ['click', 'success.f'],
            'the binding\'s keys and the registration flag are released; the consumer key and a key another element wrote stay');
        assert.deepEqual($form.boundListeners, []);
        assert.equal($form.binded, false);
        assert.equal($form.stagedUploadWait, null);
    });

    it('03.7 - executed on an unbound record: returns it untouched', function () {
        var formEl = spyEl('g');
        var $form = { binded: false, target: formEl, boundListeners: [ { el: formEl, evt: 'click', fn: function () {} } ] };
        var fn = new Function('instance', 'gina', 'return (' + unbind + ');')({ $forms: { g: $form } }, { events: { click: 'g' } });
        fn($form);
        assert.deepEqual(formEl.removed, []);
        assert.equal($form.boundListeners.length, 1);
    });

    it('03.8 - executed on spy elements: the submit trigger\'s marks and the record\'s claim are released, a mark naming ANOTHER form is kept', function () {
        // bindForm claims the trigger only for a button carrying no `data-gina-form-submit-trigger-for`
        // mark and only for a record with no `submitTrigger` yet; a destroy() + validateFormById()
        // on the same element makes a NEW record against a still-stamped button — measured on the
        // first cut: no submitTrigger, the trigger never updated, the click refused as gated
        var triggerEl = spyEl('t');
        triggerEl.dataset = { ginaFormSubmitTriggerFor: 'f' };
        triggerEl.__ginaSubmitBoundFor = 'submit.t';
        var otherEl = spyEl('u');
        otherEl.dataset = { ginaFormSubmitTriggerFor: 'other-form' };
        var formEl = spyEl('f', [ triggerEl, otherEl ]);
        var fnA = function () {}, fnB = function () {};
        var gina = { events: { 'submit.t': 't', 'submit.u': 'u' } };
        // a record carries its id (validateFormById sets it before the merge); unbindForm reads it
        // as `_id` when handed a record, and the mark is compared against it
        var $form = {
            id: 'f', binded: true, target: formEl, submitTrigger: 't',
            boundListeners: [ { el: triggerEl, evt: 'submit.t', fn: fnA }, { el: otherEl, evt: 'submit.u', fn: fnB } ],
            reassociatedListeners: []
        };
        var fn = new Function('instance', 'gina', 'return (' + unbind + ');')({ $forms: { f: $form } }, gina);

        fn($form);

        assert.deepEqual(triggerEl.removed, [ ['submit.t', fnA, false] ]);
        assert.equal(typeof triggerEl.dataset.ginaFormSubmitTriggerFor, 'undefined', 'the bind-once mark is released');
        assert.equal(typeof triggerEl.__ginaSubmitBoundFor, 'undefined', 'the #B294 expando is released');
        assert.equal(typeof $form.submitTrigger, 'undefined', 'the record\'s claim is released, so the next bind claims the trigger again');
        assert.equal(otherEl.dataset.ginaFormSubmitTriggerFor, 'other-form', 'a mark naming another form is left to that form (the control)');
        assert.deepEqual(gina.events, {}, 'both trigger keys released');
    });

    it('03.9 - the structure: the marks are released inside the ledger drain, the claim after it', function () {
        var markAt  = active.indexOf('delete entry.el.dataset.ginaFormSubmitTriggerFor;');
        var expAt   = active.indexOf('delete entry.el.__ginaSubmitBoundFor;');
        var resetAt = active.indexOf('$form.boundListeners = [];');
        var claimAt = active.indexOf('delete $form.submitTrigger;');
        assert.ok(markAt > -1 && expAt > markAt && resetAt > expAt && claimAt > resetAt);
    });
});

// ============================================================================
// §04 — destroy() removes the consumer handlers, after the destroy event
// ============================================================================
describe('#B585 §04 — destroy', function () {

    var destroy, active;
    before(function () {
        destroy = extractFunctionExpression(SRC, 'var destroy = function(formId) {');
        active  = stripComments(destroy);
    });

    it('04.1 - the destroy listener is named and detaches itself by reference', function () {
        assert.ok(active.indexOf('var onDestroyed = function(event) {') > -1);
        assert.ok(active.indexOf('event.currentTarget.removeEventListener(event.type, onDestroyed, false);') > -1);
        assert.ok(active.indexOf("addListener(gina, $form.target, 'destroy.' + _id, onDestroyed);") > -1);
        assert.equal(active.indexOf("removeListener(gina, event.currentTarget,'destroy');"), -1, 'the registry-only self-removal is gone');
    });

    it('04.2 - the consumer drain runs after unbindForm and after the destroy event', function () {
        var unbindAt  = active.indexOf('$form = unbindForm($form);');
        var triggerAt = active.indexOf("triggerEvent(gina, $form.target, 'destroy.' + _id);");
        var drainAt   = active.indexOf('Array.isArray($form.consumerListeners)');
        assert.ok(unbindAt > -1 && triggerAt > unbindAt && drainAt > triggerAt);
        assert.ok(active.indexOf('$form.consumerListeners = [];') > drainAt);
    });

    it('04.3 - executed with stubs: the handler fires, the record goes, consumer wrappers are detached and their keys released', function () {
        var formEl = spyEl('f');
        var wrapper = function () {};
        var $form = { binded: true, target: formEl, consumerListeners: [ { el: formEl, evt: 'success.f', fn: wrapper } ] };
        var instance = { $forms: { f: $form } };
        var gina = { events: { 'success.f': 'f' } };
        var attached = null, unbound = 0, cancelled = 0;
        var fn = new Function('instance', 'gina', 'addListener', 'unbindForm', 'triggerEvent', 'cancelEvent', 'uuid',
            'return (' + destroy + ');')(
            instance, gina,
            function (g, el, name, cb) { attached = { el: el, name: name, cb: cb }; gina.events[name] = el.id; },
            function ($f) { unbound++; $f.binded = false; return $f; },
            function (g, el, name) { attached.cb({ type: name, currentTarget: el, preventDefault: function () {} }); },
            function () { cancelled++; },
            function () { return 'x'; }
        );

        fn('f');

        assert.equal(attached.name, 'destroy.f');
        assert.equal(unbound, 1);
        assert.equal(cancelled, 1);
        assert.equal(typeof instance.$forms.f, 'undefined', 'the record is gone');
        assert.deepEqual(formEl.removed, [ ['destroy.f', attached.cb, false], ['success.f', wrapper, false] ],
            'its own listener first (by reference), then the consumer wrapper');
        assert.deepEqual(gina.events, {}, 'both keys released');
        assert.deepEqual($form.consumerListeners, []);
    });

    it('04.4 - the consumer drain is gated on the form being in the document (the file\'s own isConnected shape)', function () {
        var gateAt  = active.indexOf("var isFormDetached = ( typeof($form.target.isConnected) == 'boolean' && !$form.target.isConnected );");
        var drainAt = active.indexOf('Array.isArray($form.consumerListeners)');
        assert.ok(gateAt > -1 && gateAt < drainAt, 'the gate is computed once, before the drain');
        assert.ok(active.indexOf('if ( isFormDetached ) {') > drainAt, 'the drain branches on it');
    });

    it('04.5 - executed with stubs: a DETACHED form keeps its consumer wrappers (they die with the element) and still releases their keys', function () {
        // the popin teardown destroy()s a form AFTER the content was replaced or cleared, and the
        // validator's popin branch then dispatches `success.<id>` on that old form
        var formEl = spyEl('f');
        formEl.isConnected = false;
        var wrapper = function () {};
        var $form = { binded: true, target: formEl, consumerListeners: [ { el: formEl, evt: 'success.f.hform', fn: wrapper } ] };
        var instance = { $forms: { f: $form } };
        var gina = { events: { 'success.f.hform': 'f' } };
        var attached = null;
        var fn = new Function('instance', 'gina', 'addListener', 'unbindForm', 'triggerEvent', 'cancelEvent', 'uuid',
            'return (' + destroy + ');')(
            instance, gina,
            function (g, el, name, cb) { attached = { el: el, name: name, cb: cb }; gina.events[name] = el.id; },
            function ($f) { $f.binded = false; return $f; },
            function (g, el, name) { attached.cb({ type: name, currentTarget: el, preventDefault: function () {} }); },
            function () {},
            function () { return 'x'; }
        );

        fn('f');

        assert.equal(typeof instance.$forms.f, 'undefined', 'the record is gone');
        assert.deepEqual(formEl.removed, [ ['destroy.f', attached.cb, false] ],
            'only its own destroy listener is detached; the consumer wrapper stays on the detached element');
        assert.deepEqual(gina.events, {}, 'the consumer key is released all the same, so the same-id successor registers');
        assert.deepEqual($form.consumerListeners, []);

        // control: the same scene with the element CONNECTED detaches the wrapper (04.3's rule)
        var formEl2 = spyEl('g');
        formEl2.isConnected = true;
        var wrapper2 = function () {};
        var $form2 = { binded: true, target: formEl2, consumerListeners: [ { el: formEl2, evt: 'success.g.hform', fn: wrapper2 } ] };
        var instance2 = { $forms: { g: $form2 } };
        var gina2 = { events: { 'success.g.hform': 'g' } };
        var attached2 = null;
        var fn2 = new Function('instance', 'gina', 'addListener', 'unbindForm', 'triggerEvent', 'cancelEvent', 'uuid',
            'return (' + destroy + ');')(
            instance2, gina2,
            function (g, el, name, cb) { attached2 = { el: el, name: name, cb: cb }; gina2.events[name] = el.id; },
            function ($f) { $f.binded = false; return $f; },
            function (g, el, name) { attached2.cb({ type: name, currentTarget: el, preventDefault: function () {} }); },
            function () {},
            function () { return 'x'; }
        );
        fn2('g');
        assert.deepEqual(formEl2.removed, [ ['destroy.g', attached2.cb, false], ['success.g.hform', wrapper2, false] ],
            'connected: the consumer wrapper is detached (the control that makes 04.5 a reading)');
    });
});

// ============================================================================
// §05 — utils/events.js: addListener returns the callback, on() records its wrapper,
//        removeListener keeps its contract
// ============================================================================
describe('#B585 §05 — utils/events.js', function () {

    it('05.1 - addListener returns the attached callback (what makes the wrap-in-a-push shape possible)', function () {
        var fn = stripComments(extractFunctionExpression(EVT, 'function addListener(target, element, name, callback) {'));
        assert.ok(/return callback;\s*}$/.test(fn.trim()), 'the last statement returns the callback');
    });

    it('05.2 - on() records the wrapper it attaches on the handle', function () {
        var fn = stripComments(extractFunctionExpression(EVT, 'function on(event, cb) {'));
        assert.ok(fn.indexOf('if ( !Array.isArray(this.consumerListeners) ) { this.consumerListeners = []; }') > -1);
        assert.equal(countRe(fn, pushed('this.consumerListeners', '\\$target', 'event', 'addListener\\(gina, \\$target, event, function\\(e\\) \\{')), 1);
    });

    it('05.3 - executed: the wrapper is recorded once, a second registration under the same name is dropped (the add-once contract)', function () {
        var on = extractFunctionExpression(EVT, 'function on(event, cb) {');
        var formEl = { id: 'f', getAttribute: function () { return 'f'; } };
        var gina = { registeredEvents: { validator: ['success'] }, events: {} };
        var added = [];
        var fn = new Function('gina', 'addListener', 'triggerEvent', 'cancelEvent', 'instance',
            'return (' + on + ');')(
            gina,
            function (g, el, name, cb) { added.push([el, name]); gina.events[name] = el.id; return cb; },
            function () {}, function () {}, { id: 'i' }
        );
        var handle = { plugin: 'validator', id: 'f', target: formEl, eventData: {} };

        fn.call(handle, 'success', function () {});
        fn.call(handle, 'success', function () {});

        assert.equal(added.length, 1, 'one attachment');
        assert.equal(handle.consumerListeners.length, 1, 'one record');
        assert.equal(handle.consumerListeners[0].el, formEl);
        assert.equal(handle.consumerListeners[0].evt, 'success.f');
        assert.equal(typeof handle.consumerListeners[0].fn, 'function');
    });

    it('05.4 - removeListener keeps its 4th-parameter contract: handed to the DOM removal, then invoked (documented, not a handler)', function () {
        var fn = stripComments(extractFunctionExpression(EVT, 'function removeListener(target, element, name, callback) {'));
        assert.ok(fn.indexOf("if ( typeof(callback) != 'undefined' ) {") > -1);
        assert.ok(fn.indexOf('callback()') > -1);
        var doc = EVT.substring(0, EVT.indexOf('function removeListener(target, element, name, callback) {'));
        assert.ok(/completion callback/i.test(doc.slice(-2400)), 'the JSDoc right above names the contract');
    });
});

// ============================================================================
// §06 — the built bundles carry the change (RED before the rebuild)
// ============================================================================
describe('#B585 §06 — dist fidelity', function () {

    it('06.1 - both artifacts carry the ledger property names', function () {
        var distJs  = fs.readFileSync(DIST, 'utf8');
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        ['boundListeners', 'consumerListeners', 'onDestroyed'].forEach(function (s) {
            assert.ok(distJs.indexOf(s) > -1, 'gina.js missing: ' + s);
        });
        // property names survive Closure SIMPLE; the local `onDestroyed` does not, so pin the two props
        ['boundListeners', 'consumerListeners'].forEach(function (s) {
            assert.ok(count(distMin, s) >= 2, 'gina.min.js carries fewer than 2 occurrences of ' + s);
        });
        // instrument control: a literal that exists nowhere must read absent
        assert.equal(distMin.indexOf('zzz-b585-never-shipped'), -1);
    });

    it('06.2 - the by-catch is gone from the built bundle: no `addEventListener(gina,` in gina.js', function () {
        var distJs = fs.readFileSync(DIST, 'utf8');
        assert.equal(stripComments(distJs).indexOf('addEventListener(gina,'), -1);
    });
});
