'use strict';
/**
 * #B1069 — a live check, or a `query` answer, that outlives its form stops without throwing.
 *
 * `destroy()` unbinds a form's listeners and deletes `instance.$forms[id]`, but two things outlive it:
 *
 *  - `processEvent` (inside `addLiveForInput`'s listener), entered by the keyup debounce
 *    (`setTimeout(…, 1000)`) and by the deferred radio/checkbox pass (`setTimeout(…, 0)`), read
 *    `instance.$forms[event.target.form.getAttribute('id')]` and threw « Cannot set properties of
 *    undefined (setting 'isValidating') »; with the field moved out of its form, `event.target.form`
 *    is null and the same read threw on `getAttribute`;
 *  - the `query` waiter `onasyncCompleted` (inside `validate()`), a listener on the field that
 *    `destroy()` does not remove, read `$currentForm.getAttribute('id')` and then
 *    `instance.$forms[formId].resetCount`, throwing in the same two cases.
 *
 * The fix puts one guard at each place — « no form, or no record: return » — as `processEvent`'s first
 * statement and in the waiter after it has consumed its wake-up, before it reads the record. Every
 * case where the record exists runs as before. The behaviour is driven end-to-end on the real bundle
 * by `test/e2e/validator-destroy-pending-check-b1069.spec.js`; this file pins the STRUCTURE:
 *
 *  §01 the `processEvent` guard: once, the function's first statement, before the read that threw;
 *  §02 the waiter guard: once, after the consume, before `formId` and the record read;
 *  §03 both built bundles carry both guards (RED before the rebuild).
 *
 * Red-first: `GINA_B1069_MAIN=<file>` points §01/§02 at another copy of the source, and
 * `GINA_B1069_DIST=<file>` / `GINA_B1069_DIST_MIN=<file>` point §03 at other bundles — e.g. the
 * `git show <pre-fix commit>:<path>` copies; every pin must fail there.
 *
 * Usage: node --test test/core/validator-destroy-pending-check-b1069.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B1069_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.GINA_B1069_DIST || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = process.env.GINA_B1069_DIST_MIN || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

// the two guards, verbatim
var PE_GUARD = "if ( !event.target.form || typeof(instance.$forms[event.target.form.getAttribute('id')]) == 'undefined' ) {";
var WF_GUARD = "if ( !$currentForm || typeof(instance.$forms[$currentForm.getAttribute('id')]) == 'undefined' ) {";

// their anchors
var PE_DECL  = 'var processEvent = function() {';
var PE_STALE = 'if ( isStaleAfterReset() ) {';
var PE_READ  = "instance.$forms[event.target.form.getAttribute('id')].isValidating = true;";
var WAITER   = 'function onasyncCompleted(event) {';
var CONSUME  = 'event.currentTarget.removeEventListener(event.type, onasyncCompleted, false);';
var WF_DECL  = "var formId      = $currentForm.getAttribute('id');";
var WF_READ  = 'var isStaleVerdict = ( instance.$forms[formId].resetCount || 0 ) != resetCountAtPassStart;';

// the minified forms: Closure may keep the early return or invert it into the enclosing `if`, so
// both polarities of the record test are accepted; identifiers are minified
var MIN_PE = /typeof [\w$]+\.\$forms\[[\w$]+\.target\.form\.getAttribute\('id'\)\]\s*[!=]=\s*'undefined'/g;
var MIN_WF = /typeof [\w$]+\.\$forms\[[\w$]+\.getAttribute\('id'\)\]\s*[!=]=\s*'undefined'/g;

var SRC;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
});

/**
 * Occurrences of a literal string.
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    return hay.split(needle).length - 1;
}

/**
 * The text between two indexes with `//` line comments and whitespace removed: empty when only
 * comments separate the two.
 *
 * @param {string} src
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function codeBetween(src, from, to) {
    return src.slice(from, to).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
}

/**
 * Asserts the two guards and their order in one copy of the code (the source, or the unminified
 * bundle, which carries the same text).
 *
 * @param {string} src
 * @param {string} label
 * @returns {void}
 */
function assertGuards(src, label) {
    assert.equal(count(src, PE_GUARD), 1, label + ': the processEvent guard, once');
    assert.equal(count(src, WF_GUARD), 1, label + ': the waiter guard, once');

    var decl  = src.indexOf(PE_DECL);
    var guard = src.indexOf(PE_GUARD);
    var stale = src.indexOf(PE_STALE, decl);
    var read  = src.indexOf(PE_READ, decl);
    assert.ok(decl > -1 && stale > -1 && read > -1, label + ': the processEvent anchors');
    assert.equal(codeBetween(src, decl + PE_DECL.length, guard), '', label + ': the guard is the first statement');
    assert.ok(guard < stale && stale < read, label + ': the guard comes before the reset check and the read that threw');

    var at      = src.indexOf(WAITER);
    var consume = src.indexOf(CONSUME, at);
    var wGuard  = src.indexOf(WF_GUARD, at);
    var formId  = src.indexOf(WF_DECL, at);
    var wRead   = src.indexOf(WF_READ, at);
    assert.ok(at > -1 && consume > -1 && formId > -1 && wRead > -1, label + ': the waiter anchors');
    assert.ok(consume < wGuard, label + ': the waiter consumes its wake-up first');
    assert.ok(wGuard < formId && formId < wRead, label + ': the guard comes before formId and the record read');
}

// ============================================================================
// §01 — processEvent stops when its form went
// ============================================================================
describe('#B1069 §01 — processEvent', function () {

    it('01.1 - the guard is processEvent\'s first statement, before the reset check and the read that threw', function () {
        var decl  = SRC.indexOf(PE_DECL);
        var guard = SRC.indexOf(PE_GUARD);
        assert.ok(decl > -1, 'the anchor');
        assert.ok(guard > -1, 'the guard');
        assert.equal(count(SRC, PE_GUARD), 1);
        assert.equal(codeBetween(SRC, decl + PE_DECL.length, guard), '', 'only comments before it');
        assert.ok(guard < SRC.indexOf(PE_STALE, decl), 'before the reset check');
        assert.ok(guard < SRC.indexOf(PE_READ, decl), 'before the read that threw');
    });

    it('01.2 - it returns, and nothing else', function () {
        var guard = SRC.indexOf(PE_GUARD);
        assert.ok(guard > -1);
        assert.match(SRC.slice(guard + PE_GUARD.length), /^\s*return;\s*\}/);
    });
});

// ============================================================================
// §02 — the query waiter stops when its form went
// ============================================================================
describe('#B1069 §02 — the query waiter', function () {

    it('02.1 - the guard sits after the consume, before formId and the record read', function () {
        assert.equal(count(SRC, WF_GUARD), 1);
        var at = SRC.indexOf(WAITER);
        assert.ok(at > -1, 'the waiter');
        var consume = SRC.indexOf(CONSUME, at);
        var guard   = SRC.indexOf(WF_GUARD, at);
        assert.ok(consume > -1 && guard > -1);
        assert.ok(consume < guard, 'the waiter consumes its one wake-up first');
        assert.ok(guard < SRC.indexOf(WF_DECL, at), 'before formId');
        assert.ok(guard < SRC.indexOf(WF_READ, at), 'before the record read that threw');
    });

    it('02.2 - it returns, and nothing else', function () {
        var guard = SRC.indexOf(WF_GUARD);
        assert.ok(guard > -1);
        assert.match(SRC.slice(guard + WF_GUARD.length), /^\s*return;\s*\}/);
    });

    it('02.3 - CONTROL: the stale-verdict line the #B1037 pins read is unchanged', function () {
        assert.equal(count(SRC, WF_READ), 1);
    });
});

// ============================================================================
// §03 — the built bundles carry both guards (RED before the rebuild)
// ============================================================================
describe('#B1069 §03 — dist fidelity', function () {

    it('03.1 - gina.js carries both guards, in place', function () {
        assertGuards(fs.readFileSync(DIST, 'utf8'), 'gina.js');
    });

    it('03.2 - gina.min.js carries both record tests, in either polarity', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        assert.equal((min.match(MIN_PE) || []).length, 1, 'the processEvent guard');
        assert.equal((min.match(MIN_WF) || []).length, 1, 'the waiter guard');
        // instrument control: a literal that exists nowhere must read absent
        assert.equal(min.indexOf('zzz-b1069-never-shipped'), -1);
    });
});
