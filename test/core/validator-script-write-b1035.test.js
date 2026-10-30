'use strict';
/**
 * The validator fix #B1035 — a script's `el.value = …` re-checks the form and updates the gate and the
 * store, and paints nothing new — pinned in the source and in both bundles. The behaviour is driven
 * end-to-end on the real bundle by `test/e2e/validator-script-write-b1035.spec.js`.
 *
 *   §01 CONTROL — the premises, true on both sides of the fix: the value setter dispatches `change.<id>`
 *       synchronously, and `handleErrorsDisplay` puts its classes on the wrapper's parent
 *   §02 source pins (comment-stripped): the setter's mark around its dispatch; the listener reads it
 *       before anything is deferred and gives way to a message already showing, in the box the paint
 *       uses; the three paint sites hold; the gate and the store still run; the two passes are silent
 *   §03 dist fidelity (both bundles)
 *
 * Red-first: `GINA_B1035_MAIN_SRC=<file>` points §02 at another copy of the validator source (e.g.
 * `git show <commit>:<path>` before the change), and `GINA_B1035_DIST_DIR=<dir>` points §03 at another
 * dist js directory. Every arm must fail there except those labelled CONTROL.
 *
 * Usage: node --test test/core/validator-script-write-b1035.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B1035_MAIN_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_DIR = process.env.GINA_B1035_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

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
var SETTER = cutFunction(ACTIVE, 'var setObserver = function (');
var LIVE   = cutFunction(ACTIVE, 'var addLiveForInput = function(');

describe('validator-script-write-b1035 §01 — the premises (CONTROL)', function () {

    it('01.1 CONTROL — the value setter dispatches `change.<id>` synchronously', function () {
        assert.ok(SETTER.indexOf("var _evt = 'change.' + this.id;") > -1);
        assert.ok(SETTER.indexOf('triggerEvent(gina, this, _evt, val);') > -1);
    });

    it('01.2 CONTROL — handleErrorsDisplay paints on the wrapper\'s parent', function () {
        var fn = cutFunction(ACTIVE, 'var handleErrorsDisplay = function(');
        assert.match(fn, /if \( \/form\\-item\\-wrapper\$\/\.test\(\$el\.parentNode\.className\) \) \{\s*\$parent = \$el\.parentNode\.parentNode;/);
    });
});

describe('validator-script-write-b1035 §02 — source pins', function () {

    it('02.1 the setter marks the element around its dispatch, and only there', function () {
        var mark = SETTER.indexOf('this.ginaFormIsScriptWrite = true;');
        var send = SETTER.indexOf('triggerEvent(gina, this, _evt, val);');
        var drop = SETTER.indexOf('delete this.ginaFormIsScriptWrite;');
        assert.ok(mark > -1 && mark < send && send < drop, 'mark, dispatch, drop');
        assert.equal(count(ACTIVE, 'this.ginaFormIsScriptWrite'), 2);
    });

    it('02.2 the listener reads the mark before anything is deferred', function () {
        var read = LIVE.indexOf('var isQuietWrite = !!event.target.ginaFormIsScriptWrite');
        var defer = LIVE.indexOf('var processEvent = function()');
        assert.ok(read > -1, 'the read');
        assert.ok(defer > -1, 'the anchor');
        assert.ok(read < defer, 'it comes first');
    });

    it('02.3 it gives way to a message already showing, in the box the paint uses', function () {
        assert.ok(LIVE.indexOf('var $errorBox = ( /form\\-item\\-wrapper$/.test(event.target.parentNode.className) ) ? event.target.parentNode.parentNode : event.target.parentNode;') > -1);
        assert.ok(LIVE.indexOf('!/form\\-item\\-(error|warning)/.test($errorBox.className)') > -1);
    });

    it('02.4 the three paint sites hold on a quiet write', function () {
        assert.match(LIVE, /\} else if \( !isQuietWrite \) \{\s*handleErrorsDisplay\(event\.target\.form, errors, null, event\.target\.name\);/);
        assert.match(LIVE, /if \( isFormValid \|\| !isQuietWrite \) \{\s*if \(isFormValid\) \{/);
        assert.ok(LIVE.indexOf("if ( typeof(gResult.error[_touchedField]) != 'undefined' && !isQuietWrite ) {") > -1);
    });

    it('02.5 the store and the gate still run: both sit outside the paint guard', function () {
        var store = LIVE.indexOf('.errors = merge(result.error, gResult.error);');
        var guard = LIVE.indexOf("if ( typeof(gResult.error[_touchedField]) != 'undefined' && !isQuietWrite ) {");
        assert.ok(store > -1 && store < guard, 'the store comes before the guard');
        var close = LIVE.indexOf('updateSubmitTriggerState( $gForm, isFormValid);', guard);
        assert.ok(close > guard, 'the gate follows it');
        var pass = LIVE.indexOf('onSilentGlobalLiveValidation.isSilentPass = isQuietWrite;');
        assert.ok(close < pass, 'inside the same pass');
    });

    it('02.6 both passes of a quiet write are silent', function () {
        assert.equal(count(LIVE, 'onLiveValidation.isSilentPass = isQuietWrite;'), 1);
        assert.equal(count(LIVE, 'onSilentGlobalLiveValidation.isSilentPass = isQuietWrite;'), 1);
        assert.equal(count(LIVE, 'validate(event.target, localField, $localField, $form.rules, onLiveValidation);'), 1);
        assert.equal(count(LIVE, 'validate($gForm, gFields, $gFields, gRules, onSilentGlobalLiveValidation);'), 1);
    });
});

describe('validator-script-write-b1035 §03 — dist fidelity', function () {

    var RAW = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var MIN = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8');

    it('03.1 gina.js carries the mark and its read', function () {
        assert.equal(count(RAW, 'this.ginaFormIsScriptWrite = true;'), 1);
        assert.equal(count(RAW, 'var isQuietWrite = !!event.target.ginaFormIsScriptWrite'), 1);
    });

    it('03.2 gina.min.js carries the mark, its delete and its read', function () {
        assert.equal(count(MIN, 'ginaFormIsScriptWrite'), 3);
        assert.match(MIN, /delete\s+this\.ginaFormIsScriptWrite/);
    });
});
