/**
 * FormValidator — #B1055, #B1063, #B1064: on a Safari user agent, a live-checked
 * `<input autocomplete="off">` stays `readonly` until it has focus, and every key stays native.
 *
 * The defects: while such a field had focus, a keydown handler cancelled each key and rebuilt
 * the value by hand. On `email` and `number`, which have no Selection API, the text landed
 * backwards and posted that way (`123` sent `321`) with an uncaught error per key (#B1055).
 * Tab trapped or skipped, Enter did nothing (#B1063). `maxlength` was ignored, an authored
 * `readonly` was lifted, and neither `input` nor `beforeinput` fired (#B1064). The rebuild did
 * not stop Safari's list either: only `readonly` keeps a fill off the field, because Safari's
 * own form fill skips a readonly control.
 *
 * gina writes `readonly="gina"`: that value tells its own mark from a `readonly` the page wrote,
 * and a clone of a bound field carries it, so the clone still binds.
 *
 * By-catches of the same state: a field that already had focus when it bound stayed `readonly`
 * with no `focusin` to lift it (#B1067), and `destroy()` or `unbind()` left the mark on a field no
 * listener could lift it from any more (#B1068).
 *
 * Layers: source pins on the live shapes; the REAL handler and gate bytes, brace-walked out of
 * main.js and run against a fake element; dist pins on the built bundle. Each negative pin was
 * read firing on develop's bytes before the fix. The browser behaviour is pinned in
 * test/e2e/validator-autocomplete-readonly-b1055.spec.js.
 *
 * Run: node --test test/core/validator-autocomplete-readonly-b1055.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require(path.join(__dirname, '..', 'fw'));
var JS_DIR = path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js');
var mainSrc = fs.readFileSync(path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'main.js'), 'utf8');
var distSrc = fs.readFileSync(path.join(JS_DIR, 'gina.js'), 'utf8');
// Closure line-wraps through tokens: read the min with its line breaks removed
var distMin = fs.readFileSync(path.join(JS_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');

/**
 * Removes the comment lines a source read must not match.
 *
 * @param {string} src - source text
 * @returns {string} the text without its comment lines
 */
function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * Counts the occurrences of a literal.
 *
 * @param {string} hay - text to search
 * @param {string} needle - literal to count
 * @returns {number} how many times it occurs
 */
function count(hay, needle) {
    return hay.split(needle).length - 1;
}

/**
 * Brace-walks a `var <name> = function…` declaration out of main.js.
 *
 * @param {string} name - the variable's name
 * @returns {string} the function expression's text, or '' when it is absent
 */
function fnText(name) {
    var at = mainSrc.indexOf('var ' + name + ' = function');
    if (at < 0) { return ''; }
    var depth = 0;
    for (var j = mainSrc.indexOf('{', at); j < mainSrc.length; j++) {
        if (mainSrc[j] === '{') { depth++; }
        else if (mainSrc[j] === '}' && --depth === 0) {
            return mainSrc.substring(at + ('var ' + name + ' = ').length, j + 1);
        }
    }
    return '';
}

/**
 * Walks the parentheses of the gate's `if` out of registerForLiveChecking.
 *
 * @returns {string} the condition's text, or '' when it is absent
 */
function gateText() {
    var slice = fnText('registerForLiveChecking');
    var at = slice.indexOf("var isAutoCompleteField = $el.getAttribute('autocomplete');");
    if (at < 0) { return ''; }
    var open = slice.indexOf('if (', at) + 3;
    var depth = 0;
    for (var j = open; j < slice.length; j++) {
        if (slice[j] === '(') { depth++; }
        else if (slice[j] === ')' && --depth === 0) {
            return slice.substring(open, j + 1);
        }
    }
    return '';
}

var markMatch = mainSrc.match(/var autoCompleteReadonlyMark = '([^']+)';/);
var MARK = markMatch ? markMatch[1] : null;

/**
 * A fake element with a real attribute map.
 *
 * @param {object} [attrs] - initial attributes
 * @returns {object} the element
 */
function makeEl(attrs) {
    var a = Object.assign({}, attrs || {});
    return {
        id: 'f',
        form: null,
        hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(a, k); },
        getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null; },
        setAttribute: function (k, v) { a[k] = String(v); },
        removeAttribute: function (k) { delete a[k]; }
    };
}

/**
 * Runs the real handler bytes on an element and returns what a test drives.
 *
 * @param {object} el - the element from makeEl
 * @param {boolean} [focused] - whether the field already has focus when it binds
 * @returns {{fire: function(string): void, listeners: string[], triggered: string[]}} the driver
 */
function bind(el, focused) {
    var listeners = {}, triggered = [];
    var addListener = function (target, $e, evt, fn) { listeners[evt] = fn; return fn; };
    var triggerEvent = function (target, $e, evt) { triggered.push(evt); };
    var handler = new Function(
        'gina', 'addListener', 'triggerEvent', 'autoCompleteReadonlyMark', 'document',
        'return ( ' + fnText('handleAutoComplete') + ' );'
    )({}, addListener, triggerEvent, MARK, { activeElement: focused ? el : null });
    handler(el);
    return {
        fire: function (evt) { listeners[evt]({ preventDefault: function () {}, currentTarget: el }); },
        listeners: Object.keys(listeners),
        triggered: triggered
    };
}

describe('#B1055 §01 — source pins', function () {

    it('01.1 - extraction controls: the handler, its gate and the mark are read', function () {
        assert.ok(fnText('handleAutoComplete').indexOf('focusin') > -1, 'handleAutoComplete not extracted');
        assert.ok(gateText().indexOf('/safari/i') > -1, 'the gate not extracted');
        assert.equal(MARK, 'gina');
    });

    it('01.2 - the handler adds no keydown listener and cancels no key', function () {
        var active = stripComments(fnText('handleAutoComplete'));
        assert.equal(active.indexOf('keydown'), -1);
        assert.equal(active.indexOf('e.preventDefault'), -1);
        assert.equal(active.indexOf('.value'), -1, 'the handler no longer writes the value');
    });

    it('01.3 - the rebuild\'s helpers are out of the source', function () {
        var active = stripComments(mainSrc);
        assert.ok(active.indexOf('var registerForLiveChecking') > -1, 'control: the strip left the code');
        ['commitCaret', 'queueCaretRestore', 'setCaretToPos', 'focusNextElement', 'isElementVisible', '_ginaAcCaret', '_ginaAcPending'].forEach(function (name) {
            assert.equal(count(active, name), 0, name);
        });
    });

    it('01.4 - bind and blur write the mark, focus lifts only the mark', function () {
        var active = stripComments(fnText('handleAutoComplete'));
        assert.equal(count(active, "$el.setAttribute('readonly', autoCompleteReadonlyMark);"), 1);
        assert.equal(count(active, "$_el.setAttribute('readonly', autoCompleteReadonlyMark);"), 1);
        assert.ok(active.indexOf("if ( !$_el.hasAttribute('readonly') ) {") < active.indexOf("$_el.setAttribute('readonly', autoCompleteReadonlyMark);"));
        assert.ok(active.indexOf("if ( event.currentTarget.getAttribute('readonly') == autoCompleteReadonlyMark ) {") < active.indexOf("event.currentTarget.removeAttribute('readonly');"));
        assert.equal(count(active, "'readonly', 'readonly'"), 0, 'no bare readonly write is left');
    });

    it('01.5 - the gate skips a field with a readonly the page wrote', function () {
        var gate = gateText();
        assert.ok(gate.indexOf("( !$el.hasAttribute('readonly') || $el.getAttribute('readonly') == autoCompleteReadonlyMark )") > -1);
        assert.ok(gate.indexOf('/^(off|false)/i.test(isAutoCompleteField)') < gate.indexOf('hasAttribute'));
    });

    it('01.6 - focusout still dispatches change.<id>: a required field left empty shows its error on blur', function () {
        var active = stripComments(fnText('handleAutoComplete'));
        assert.equal(count(active, "triggerEvent(gina, $_el, 'change.'+ $_el.id);"), 1);
    });
});

describe('#B1055 §02 — the real handler bytes, on a fake element', function () {

    it('02.1 - bind writes the mark and attaches focusin and focusout only', function () {
        var el = makeEl();
        var d = bind(el);
        assert.equal(el.getAttribute('readonly'), 'gina');
        assert.deepEqual(d.listeners.sort(), ['focusin.f', 'focusout.f']);
    });

    it('02.2 - focus lifts the mark; blur writes it back and dispatches change.<id> once', function () {
        var el = makeEl();
        var d = bind(el);
        d.fire('focusin.f');
        assert.equal(el.hasAttribute('readonly'), false);
        d.fire('focusout.f');
        assert.equal(el.getAttribute('readonly'), 'gina');
        assert.deepEqual(d.triggered, ['change.f']);
    });

    ['', 'readonly'].forEach(function (value) {
        it('02.3 - a readonly="' + value + '" the page set at rest survives focus and blur', function () {
            var el = makeEl();
            var d = bind(el);
            el.setAttribute('readonly', value);
            d.fire('focusin.f');
            assert.equal(el.getAttribute('readonly'), value);
            d.fire('focusout.f');
            assert.equal(el.getAttribute('readonly'), value);
        });

        it('02.4 - a readonly="' + value + '" the page set during focus survives blur and the next focus', function () {
            var el = makeEl();
            var d = bind(el);
            d.fire('focusin.f');
            el.setAttribute('readonly', value);
            d.fire('focusout.f');
            assert.equal(el.getAttribute('readonly'), value);
            d.fire('focusin.f');
            assert.equal(el.getAttribute('readonly'), value);
        });
    });

    it('02.5 - once the page unlocks the field, blur writes the mark again', function () {
        var el = makeEl();
        var d = bind(el);
        el.setAttribute('readonly', '');
        el.removeAttribute('readonly');
        d.fire('focusin.f');
        assert.equal(el.hasAttribute('readonly'), false);
        d.fire('focusout.f');
        assert.equal(el.getAttribute('readonly'), 'gina');
    });

    it('02.6 - #B1067: a field that already has focus at bind stays editable, and takes the mark on blur', function () {
        var el = makeEl();
        var d = bind(el, true);
        assert.equal(el.hasAttribute('readonly'), false);
        d.fire('focusout.f');
        assert.equal(el.getAttribute('readonly'), 'gina');
    });
});

describe('#B1068 — unbindForm, the real bytes', function () {

    /**
     * Runs the real unbindForm bytes on a form holding one owned control.
     *
     * @param {object} el - the owned control, from makeEl
     * @returns {object} the control, after the unbind
     */
    function unbind(el) {
        var formEl = { id: 'u', elements: [el], removeEventListener: function () {}, getAttribute: function () { return 'u'; } };
        var $form = { binded: true, target: formEl, boundListeners: [], reassociatedListeners: [] };
        new Function('instance', 'gina', 'return ( ' + fnText('unbindForm') + ' );')({ $forms: { u: $form } }, { events: {} })($form);
        return el;
    }

    it('03b.1 - the literal it compares is the mark', function () {
        assert.ok(stripComments(fnText('unbindForm')).indexOf("getAttribute('readonly') == '" + MARK + "'") > -1);
    });

    it('03b.2 - gina\'s mark goes with the binding', function () {
        assert.equal(unbind(makeEl({ readonly: 'gina' })).hasAttribute('readonly'), false);
    });

    ['', 'readonly'].forEach(function (value) {
        it('03b.3 - a readonly="' + value + '" the page wrote stays', function () {
            assert.equal(unbind(makeEl({ readonly: value })).getAttribute('readonly'), value);
        });
    });
});

describe('#B1055 §03 — the gate\'s real bytes', function () {

    var SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    var CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    var rows = [
        ['Safari, off, no readonly', SAFARI, 'off', null, true],
        ['Safari, false, no readonly', SAFARI, 'false', null, true],
        ['Safari, off, gina\'s mark (a re-bind, a clone)', SAFARI, 'off', 'gina', true],
        ['Safari, off, readonly=""', SAFARI, 'off', '', false],
        ['Safari, off, readonly="readonly"', SAFARI, 'off', 'readonly', false],
        ['Safari, on', SAFARI, 'on', null, false],
        ['Safari, no autocomplete', SAFARI, null, null, false],
        ['Chrome, off', CHROME, 'off', null, false]
    ];
    rows.forEach(function (row) {
        it('03 - ' + row[0], function () {
            var gate = new Function('navigator', '$el', 'isAutoCompleteField', 'autoCompleteReadonlyMark', 'return ' + gateText() + ';');
            var el = makeEl(row[3] === null ? {} : { readonly: row[3] });
            assert.equal(!!gate({ userAgent: row[1] }, el, row[2], MARK), row[4]);
        });
    });
});

describe('#B1055 §04 — dist fidelity', function () {

    it('04.1 - gina.js carries the mark and has no rebuild', function () {
        var active = stripComments(distSrc);
        assert.equal(count(active, "var autoCompleteReadonlyMark = 'gina';"), 1);
        assert.equal(count(active, 'var handleAutoComplete = function($el) {'), 1);
        assert.equal(count(active, 'commitCaret'), 0);
        assert.equal(count(active, 'queueCaretRestore'), 0);
    });

    it('04.2 - gina.min.js writes the mark twice and reads it at the gate and at focus', function () {
        assert.equal(count(distMin, "setAttribute('readonly','gina')"), 2);
        assert.equal((distMin.match(/getAttribute\('readonly'\)[!=]='gina'/g) || []).length, 3);
        assert.equal(count(distMin, "hasAttribute('readonly')"), 2);
    });

    it('04.3 - gina.min.js has no rebuild: no bare readonly write, no caret code', function () {
        assert.ok(count(distMin, 'chrom(e|ium)') >= 1, 'control: the gate is in this bundle');
        assert.equal(count(distMin, "setAttribute('readonly','readonly')"), 0);
        assert.equal(count(distMin, 'setSelectionRange'), 0);
        assert.equal(count(distMin, '_ginaAc'), 0);
    });
});
