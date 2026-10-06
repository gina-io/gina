'use strict';
/**
 * FormValidator - a <select>'s live check reads the element it is given (#B781)
 *
 * `updateSelect($el, $form)` runs a select's live check when it changes: a pass over the select
 * alone, then, in that pass's callback, a pass over the whole form, whose verdict can differ
 * (a rule that compares two fields). It read the element from the global `event`
 * (`window.event`) instead of `$el`. `window.event` is the event being dispatched when it is
 * read: the `change` while the listener runs, but `validate()` delivers each result inside its
 * own `validated.<id>` dispatch on the node it validated. In the whole-form pass that node is
 * the form, so the touched field's name became the form's own `name`, the lookup missed, and
 * the select's error from the whole-form check was never displayed. The input path is not
 * affected: its `event` is its listener's own parameter.
 *
 * Strategy:
 *  - 01 source pins on the extracted `updateSelect` (line-anchored declaration, uniqueness- and
 *    balance-gated brace walk), on a comment-stripped view: no bare `event` read remains, and
 *    the element is passed to validate() and named in every display call. The same `event`
 *    pattern must match the RAW text (its `was:` comment), so the zero is not a blind needle.
 *  - 02 behaviour: the REAL `updateSelect` bytes evaluated inside a jsdom window's own realm,
 *    so a bare `event` resolves to jsdom's `window.event` as it does in a browser (jsdom
 *    implements it per the DOM spec). A real `change` is dispatched on a real <select> through
 *    a listener of the plugin's shape; `validate()` is a stub that delivers its result the way
 *    the real one does, inside a `validated.<id>` dispatch on the node it was given. 02.4 is a
 *    control that passes on the pre-fix bytes too, so a red 02.1-02.3 is the defect, not the
 *    harness.
 *  - 03 dist fidelity: the unminified bundle carries the fixed lines; the minified bundle holds
 *    no `event.target` (Closure renames a local `event` parameter, so a surviving
 *    `event.target` is a read of the global) and still carries updateSelect's own debug
 *    string, so the zero is not an absent function.
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * GINA_VALIDATOR_MAIN=<copy of main.js>, GINA_PLUGIN_DIST=<dir holding js/>.
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM, VirtualConsole } = require('jsdom');

var FW = require('../fw');

var MAIN     = process.env.GINA_VALIDATOR_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.GINA_PLUGIN_DIST    || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_JS  = path.join(DIST, 'js/gina.min.js');
var DIST_RAW = path.join(DIST, 'js/gina.js');

/** A bare `event` identifier: not a property (`x.event`), not part of a longer name. */
var BARE_EVENT = /(^|[^.\w$])event\b/g;

var src, block, code;
before(function () {
    src   = fs.readFileSync(MAIN, 'utf8');
    block = extractFn(src, 'updateSelect');
    // the trailing-comment strip below would cut a string holding `//`: updateSelect has none
    assert.equal(/['"][^'"\n]*\/\//.test(block), false, '[instrument] a string in updateSelect holds //');
    code  = block.split('\n').map(function (l) {
        return /^\s*(\/\/|\*|\/\*\*|\/\*)/.test(l) ? '' : l.replace(/\/\/.*$/, '');
    }).join('\n');
});

/**
 * Extract `var <name> = function(...) {...}` from the shipped source: line-anchored declaration,
 * uniqueness-gated, started-flag brace walk, balance-gated. updateSelect holds no brace inside a
 * string or regex literal (checked by reading it), which the naive walker requires.
 *
 * @inner
 * @param {string} source
 * @param {string} name
 * @returns {string} The function expression, from `function` to its closing brace
 */
function extractFn(source, name) {
    var re = new RegExp('^[ \\t]*var ' + name + ' = function\\(', 'mg');
    var m  = re.exec(source);
    assert.ok(m, 'declaration of ' + name + ' not found');
    assert.equal(re.exec(source), null, 'declaration of ' + name + ' is not unique');
    var start = source.indexOf('function', m.index);
    var i = start, depth = 0, started = false;
    for (; i < source.length; i++) {
        var c = source[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.ok(started && depth === 0, 'unbalanced braces extracting ' + name);
    return source.substring(start, i);
}

/**
 * Counts the occurrences of a literal needle.
 *
 * @inner
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function count(text, needle) {
    var n = 0, i = -1;
    while ((i = text.indexOf(needle, i + 1)) > -1) { n++; }
    return n;
}

/**
 * Runs one `change` on a <select> through the real updateSelect bytes in a jsdom realm.
 *
 * @inner
 * @param {string} formHtml - The form, holding `<select id="s1" name="country">`
 * @param {{local: ?object, global: ?object}} verdicts - The errors each pass returns, `null` for valid
 * @returns {{calls: Array<{field: *, hasError: boolean}>, lookups: string[], thrown: ?string}}
 *   The display calls, the keys the whole-form pass looked its error up by, and any throw
 */
function runSelectChange(formHtml, verdicts) {
    var thrown = null;
    // a throw inside a listener reaches jsdom's virtual console: a window-level `error` listener
    // cannot be added under Bun (jsdom rejects the window as an EventTarget there)
    var vc = new VirtualConsole();
    vc.on('jsdomError', function (e) { thrown = (e && e.message) || String(e); });
    var dom = new JSDOM('<!DOCTYPE html><html><body>' + formHtml + '</body></html>', { runScripts: 'outside-only', virtualConsole: vc });
    var w = dom.window;
    // gina's Object#count (utils/prototypes.js), installed in the jsdom realm, where the objects live
    w.eval("Object.defineProperty(Object.prototype, 'count', { value: function () { return Object.keys(this).length; }, enumerable: false, configurable: true });");
    // the free variables updateSelect closes over are parameters here; `event` deliberately is not
    w.eval(
        'window.__mk = function (instance, validate, handleErrorsDisplay, excludeWithheldAutofill, getFormValidationInfos, rules, updateSubmitTriggerState, console) {\n' +
        '    var once = false;\n    var updateSelect = ' + block + ';\n    return updateSelect;\n};'
    );
    var W = function (o) { return w.JSON.parse(JSON.stringify(o)); };
    var formEl   = w.document.getElementById('f1');
    var selectEl = w.document.getElementById('s1');
    var calls = [], lookups = [];

    var instance = W({ $forms: { f1: { isValidating: false, rules: { country: { isRequired: true } } } } });
    var validate = function ($node, fields, $fields, rules_, cb) {
        var id     = $node.getAttribute('id');
        var isForm = /^form$/i.test($node.tagName);
        var errors = (isForm ? verdicts.global : verdicts.local);
        var error  = W(errors || {});
        if (isForm) {
            error = new w.Proxy(error, { get: function (t, k) {
                if (typeof k === 'string' && k !== 'count' && k !== 'toJSON') { lookups.push(k); }
                return t[k];
            } });
        }
        // the real delivery: the callback runs inside a `validated.<id>` dispatch on that node
        $node.addEventListener('validated.' + id, function onValidated(e) {
            e.currentTarget.removeEventListener(e.type, onValidated, false);
            var result = W({ data: { country: selectEl.value } });
            result.isValid = function () { return !errors; };
            result.error = error;
            cb(result);
        });
        $node.dispatchEvent(new w.CustomEvent('validated.' + id, { detail: cb, bubbles: true, cancelable: true }));
    };
    var handleErrorsDisplay = function ($f, errs, data, fieldName) {
        calls.push({ field: fieldName, hasError: !!(errs && typeof fieldName === 'string' && errs[fieldName]) });
    };
    var getFormValidationInfos = function () {
        var infos = W({ fields: { country: selectEl.value }, $fields: {} });
        infos.$fields.country = selectEl;
        return infos;
    };
    var updateSelect = w.__mk(
        instance, validate, handleErrorsDisplay, function (x) { return x; }, getFormValidationInfos,
        W({ country: { isRequired: true } }), function () {}, w.eval('({ debug: function () {} })')
    );
    var $form = W({ rules: { country: { isRequired: true } } });
    $form.target = formEl;
    // the listener shape of the plugin's select binding
    selectEl.addEventListener('change', function (event) {
        var $el = event.target;
        if (/select/i.test($el.type)) { updateSelect($el, $form); }
    });
    try {
        selectEl.dispatchEvent(new w.Event('change', { bubbles: true }));
    } catch (e) {
        thrown = e.message;
    }
    return { calls: calls, lookups: lookups, thrown: thrown };
}

var NAMED_FORM = '<form id="f1" name="signup" data-gina-form-live-check-enabled="true">' +
                 '<select id="s1" name="country"><option value="">--</option><option value="fr">FR</option></select></form>';
var NAME_CONTROL_FORM = '<form id="f1" data-gina-form-live-check-enabled="true"><input id="n1" name="name" value="x">' +
                 '<select id="s1" name="country"><option value="">--</option><option value="fr">FR</option></select></form>';
var REQUIRED = { country: { isRequired: 'Country is required' } };


describe('01 - source pins on updateSelect', function () {

    it('01.1 reads no global `event` (comment-stripped)', function () {
        var hits = code.match(BARE_EVENT) || [];
        assert.equal(hits.length, 0, 'bare `event` reads left: ' + hits.length);
    });

    it('01.2 CONTROL - the same pattern matches the raw text (its was: comment)', function () {
        assert.ok((block.match(BARE_EVENT) || []).length > 0, 'the `event` pattern matched nothing in the raw text');
    });

    it('01.3 the element it is given is validated and named in every display call', function () {
        assert.equal(count(code, 'validate($el, localField, $localField, $form.rules, function onLiveValidation('), 1);
        assert.match(code, /(^|[^$\w])localField\[\$el\.name\]\s*=\s*\$el\.value;/);
        assert.match(code, /\$localField\[\$el\.name\]\s*=\s*\$el;/);
        assert.equal(count(code, 'handleErrorsDisplay($localForm, {}, result.data, $el.name);'), 1);
        assert.equal(count(code, 'handleErrorsDisplay($localForm, result.error, result.data, $el.name);'), 1);
        assert.equal(count(code, 'var _touchedField = $el.name;'), 1);
    });
});


describe('02 - a change on a <select>, the real updateSelect bytes in a jsdom realm', function () {

    it('02.1 an error only the whole-form pass returns (a rule comparing fields) is displayed for the select', function () {
        var r = runSelectChange(NAMED_FORM, { local: null, global: REQUIRED });
        assert.equal(r.thrown, null);
        assert.deepEqual(r.calls, [
            { field: 'country', hasError: false },
            { field: 'country', hasError: true }
        ], 'whole-form error keys looked up: ' + JSON.stringify(r.lookups));
    });

    it('02.2 both passes return an error: both are displayed for the select', function () {
        var r = runSelectChange(NAMED_FORM, { local: REQUIRED, global: REQUIRED });
        assert.equal(r.thrown, null);
        assert.deepEqual(r.calls, [
            { field: 'country', hasError: true },
            { field: 'country', hasError: true }
        ], 'whole-form error keys looked up: ' + JSON.stringify(r.lookups));
        assert.ok(r.lookups.length > 0 && r.lookups.every(function (k) { return k === 'country'; }), JSON.stringify(r.lookups));
    });

    it('02.3 a form holding a control named `name`: still the select', function () {
        var r = runSelectChange(NAME_CONTROL_FORM, { local: REQUIRED, global: REQUIRED });
        assert.equal(r.thrown, null);
        assert.deepEqual(r.calls.map(function (c) { return c.field; }), ['country', 'country'], 'whole-form error keys looked up: ' + JSON.stringify(r.lookups));
    });

    it('02.4 CONTROL - both passes valid: one reset for the select, nothing else (as before the fix)', function () {
        var r = runSelectChange(NAMED_FORM, { local: null, global: null });
        assert.equal(r.thrown, null);
        assert.deepEqual(r.calls, [{ field: 'country', hasError: false }]);
    });
});


describe('03 - dist fidelity', function () {
    var minjs, rawjs;
    before(function () {
        minjs = fs.readFileSync(DIST_JS, 'utf8');
        rawjs = fs.readFileSync(DIST_RAW, 'utf8');
    });

    it('03.1 the unminified bundle carries the fixed lines', function () {
        assert.equal(count(rawjs, 'validate($el, localField, $localField, $form.rules, function onLiveValidation(result){'), 1);
        assert.equal(count(rawjs, 'var _touchedField = $el.name;'), 1);
    });

    it('03.2 the minified bundle reads no global `event.target`', function () {
        assert.equal(count(minjs, 'event.target'), 0, 'global `event.target` reads in gina.min.js');
    });

    it('03.3 CONTROL - the minified bundle carries updateSelect (its debug string)', function () {
        assert.equal(count(minjs, '[updateSelect]: onSilentGlobalLiveValidation: '), 1);
    });
});
