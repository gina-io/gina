'use strict';
/**
 * FormValidator - a server field error reaches the visible twin of a hidden-first
 * same-name pair (#B510)
 *
 * `handleErrorsDisplay` walks `$form.elements` in document order. On the per-field path
 * (`fieldName` set) it exits on the FIRST control whose name matches, whether or not
 * anything was painted - and every paint gate skips a bare `type=hidden` control. So a
 * hidden twin listed BEFORE its visible sibling consumed the error: no message, no
 * `aria-invalid`. On a shared box it also pre-marked the box's error class, which blocked
 * the twin's first-error branch even when the walk did go on. The pattern is the one the
 * plugin's own source recommends (a hidden twin with `"exclude": false` so a disabled
 * control still posts).
 *
 * The fix: a bare hidden control (no `form-item-wrapper`) is skipped - no class, no
 * message node, no announce, no exit - when another control of the same name can be
 * painted (`hasPaintableTwin`). A lone bare hidden keeps the former behaviour; a wrapped
 * hidden keeps its contract (painted after the wrapper).
 *
 * Strategy:
 *  - 01 source pins: the helper, the guard, its position (inside the walk, before the
 *    first class mutation and before the name-match exit), with anti-vacuity controls;
 *  - 02 `hasPaintableTwin` EXTRACTED from the shipped plugin bytes and executed against
 *    jsdom forms (no replica): the seven shapes the e2e fixture carries;
 *  - 03 dist fidelity of the helper's own wrapper test in the minified bundle.
 *  The real-bytes BEHAVIOURAL arm is test/e2e/validator-hidden-first-paint.spec.js
 *  (red before the fix on arms 03-05, green after; the controls 01/02/06/07 unchanged).
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * GINA_VALIDATOR_MAIN=<plugin main.js>, GINA_PLUGIN_DIST=<dir holding js/>.
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW = require('../fw');

var MAIN    = process.env.GINA_VALIDATOR_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST    = process.env.GINA_PLUGIN_DIST    || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_JS = path.join(DIST, 'js/gina.min.js');

var DECL   = 'var handleErrorsDisplay = function($form, errors, data, fieldName) {';
var WALK   = 'for (var i = 0, len = $form.length; i<len; ++i) {';
var GUARD  = "if ( $target === $el && $el.type == 'hidden' && hasPaintableTwin($form, $el) ) {";
var HELPER = 'var hasPaintableTwin = function($form, $el) {';
var MARK   = "? 'form-item-error' : ' form-item-error'";  // the box-class mutation (first-error branch)
var EXIT   = 'fieldName === $el.name';                     // the name-match exit at the end of the walk

var src, active;
before(function () {
    src    = fs.readFileSync(MAIN, 'utf8');
    active = stripComments(src);
});

/** Lines that are not `//` / JSDoc comment lines (the pins must not count rationale). */
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*\*|\/\*)/.test(l); }).join('\n');
}
function count(text, needle) {
    var n = 0, i = -1;
    while ((i = text.indexOf(needle, i + 1)) > -1) { n++; }
    return n;
}
/** Brace walk from the `function` keyword at `start`; balance-gated. */
function walkFunction(source, start) {
    var i = start, depth = 0, started = false;
    for (; i < source.length; i++) {
        var c = source[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.ok(started && depth === 0, 'unbalanced braces from offset ' + start);
    return source.substring(start, i);
}
/** `var <name> = function(` - line-anchored, uniqueness-gated. */
function extractVarFn(source, name) {
    var re = new RegExp('^[ \\t]*var ' + name + ' = function\\(', 'mg');
    var m  = re.exec(source);
    assert.ok(m, 'declaration of ' + name + ' not found');
    assert.equal(re.exec(source), null, 'declaration of ' + name + ' is not unique');
    return walkFunction(source, source.indexOf('function', m.index));
}

describe('#B510 01 - source pins on the plugin', function () {

    it('01.1 the helper is declared exactly once', function () {
        assert.equal(count(active, HELPER), 1);
    });

    it('01.2 the walk carries the bare-hidden guard exactly once, and it skips the control', function () {
        assert.equal(count(active, GUARD), 1);
        var at = active.indexOf(GUARD);
        var tail = active.substring(at + GUARD.length, at + GUARD.length + 80);
        assert.match(tail, /^\s*continue;/, 'the guard must `continue` (skip the control), got: ' + JSON.stringify(tail));
    });

    it('01.3 the guard sits inside handleErrorsDisplay\'s walk, after the loop head and before both the class mutation and the name-match exit', function () {
        var decl = active.indexOf(DECL);
        assert.ok(decl > -1, 'declaration anchor missing');
        var walk = active.indexOf(WALK, decl);
        var mark = active.indexOf(MARK, decl);
        var exit = active.indexOf(EXIT, decl);
        var guard = active.indexOf(GUARD, decl);
        // anti-vacuity: every anchor resolves after the declaration
        assert.ok(walk > decl, 'walk anchor missing after the declaration');
        assert.ok(mark > decl, 'class-mutation anchor missing after the declaration');
        assert.ok(exit > decl, 'name-match exit anchor missing after the declaration');
        assert.ok(guard > walk,  'the guard must come after the loop head');
        assert.ok(guard < mark,  'the guard must come before the first-error class mutation');
        assert.ok(guard < exit,  'the guard must come before the name-match exit');
    });

    it('01.4 control (non-discriminating, by design): the name-match exit is unchanged and unique', function () {
        assert.equal(count(active, EXIT), 1);
    });

    it('01.5 the helper does not count a bare hidden twin as paintable, but does count a wrapped one', function () {
        var fn = extractVarFn(active, 'hasPaintableTwin');
        assert.ok(fn.indexOf("$other.type == 'hidden'") > -1, 'the bare-hidden exclusion is missing');
        assert.ok(fn.indexOf('/form\\-item\\-wrapper$/') > -1, 'the wrapper exemption is missing');
    });
});

describe('#B510 02 - hasPaintableTwin executed from the shipped bytes against jsdom forms', function () {

    var hasPaintableTwin;
    before(function () {
        var fn = extractVarFn(active, 'hasPaintableTwin');
        hasPaintableTwin = new Function('return ' + fn)();
        assert.equal(typeof hasPaintableTwin, 'function');
    });

    function formOf(inner) {
        var dom = new JSDOM('<!doctype html><body><form id="f">' + inner + '</form></body>');
        return dom.window.document.getElementById('f');
    }

    it('02.1 shared box: hidden first, a visible twin after it -> true for the hidden', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"><input type="text" name="a" id="v"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), true);
    });

    it('02.2 separate boxes -> true', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"></div><div class="form-item"><input type="text" name="a" id="v"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), true);
    });

    it('02.3 a lone bare hidden -> false (keeps the former behaviour)', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), false);
    });

    it('02.4 two bare hidden twins -> false (neither can be painted)', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"><input type="hidden" name="a" id="h2"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), false);
    });

    it('02.5 a WRAPPED hidden twin counts as paintable -> true', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"></div><div class="form-item"><div class="form-item-wrapper"><input type="hidden" name="a" id="w"></div></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), true);
    });

    it('02.6 control: a visible control of ANOTHER name is not a twin -> false', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"><input type="text" name="b" id="v"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), false);
    });

    it('02.7 a DISABLED visible twin still counts (disabled is not a paint gate) -> true', function () {
        var f = formOf('<div class="form-item"><input type="hidden" name="a" id="h"><input type="text" name="a" id="v" disabled></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), true);
    });

    it('02.8 a nameless control -> false, and the control itself is never its own twin', function () {
        var f = formOf('<div class="form-item"><input type="hidden" id="h"></div>');
        assert.equal(hasPaintableTwin(f, f.querySelector('#h')), false);
        var g = formOf('<div class="form-item"><input type="hidden" name="a" id="h"></div>');
        assert.equal(hasPaintableTwin(g, g.querySelector('#h')), false);
    });
});

describe('#B510 03 - dist fidelity', function () {

    it('03.1 the minified bundle carries the wrapper test twice (the walk\'s and the helper\'s)', function () {
        var min = fs.readFileSync(DIST_JS, 'utf8');
        // Closure keeps regex literals; count both the escaped and the unescaped spelling
        // with a split-count (grep -c counts LINES on a near-single-line artifact).
        var n = (min.match(/form(\\-|-)item(\\-|-)wrapper\$/g) || []).length;
        assert.ok(n >= 2, 'expected the wrapper regex at least twice in gina.min.js, got ' + n);
        // stuck-true control: a needle that must never match
        assert.equal((min.match(/zzz-bogus-never-wrapper\$/g) || []).length, 0);
    });
});
