'use strict';

// #B265 — a multi-form popin's teardown must destroy EVERY tracked validator form.
//
// The original loop spliced `$popin['$forms']` while iterating it against a length
// captured before the loop, so each splice shifted the array left under an incrementing
// cursor and the read index skipped one every time. The originally odd-indexed forms
// were never destroyed and were left behind in the array the loop exists to empty; their
// validator entries then survived pointing at nodes already detached by the popin's
// `innerHTML = ''`, so `validateFormById` returned the stale entry on the next open and
// the form was never re-bound.
//
// Shape of this file, matching popin.test.js:
//  - a test-local REPLICA of the teardown loop is exercised directly, so the skip
//    behaviour is observable without booting a browser;
//  - SOURCE PINS then lock popin/main.js to that replica so the two cannot drift.
//
// Why not an e2e browser test: the loop is gated on the popin's registered validator,
// `$popin.options.validator`, falling back to the per-instance `$validatorInstance`
// (popin/main.js, since #B756); both come ONLY from `options.validator`. gina's own boot
// constructs `new Popin({ name: 'gina-dialog-boot' })` with no validator, and the
// delegated `data-gina-dialog` listener is installed once by that boot instance (module
// guard `_ginaDialogDelegated`). So the declarative path can never reach this loop, and
// an e2e arm driving it would be a void scene — every arm reading "nothing destroyed"
// for a reason unrelated to the defect.
// The documented `gina.popin.close(name)` path does reach the loop since #B756: test 04 of
// test/e2e/validator-upload-popin-reopen-b733.spec.js.

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC = path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');

var _popinSrc;
function getPopinSrc() { return _popinSrc || (_popinSrc = fs.readFileSync(POPIN_SRC, 'utf8')); }

/**
 * Test-local replica of popin/main.js's validator-form teardown — MUST mirror the source.
 * The source pins in section 04 lock the production shape to this replica.
 *
 * @param {string[]} formIds - the popin's tracked form ids ($popin['$forms'])
 * @param {object} registry  - the validator registry (the popin validator's `$forms`)
 * @param {string[]} [throwFor] - ids whose destroy() should throw, to exercise the guard
 * @returns {{destroyed: string[], leftInArray: string[], warned: string[]}}
 */
function teardownReplica(formIds, registry, throwFor) {
    var destroyed = [];
    var warned = [];
    var $popinForms = formIds.slice();
    var _throwFor = throwFor || [];

    if (registry) {
        var _formIds = $popinForms.slice();
        $popinForms.length = 0;
        for (var i = 0, _formIdsLen = _formIds.length; i < _formIdsLen; ++i) {
            var $formToDestroy = registry[_formIds[i]];
            if (typeof ($formToDestroy) == 'undefined') {
                continue;
            }
            try {
                if (_throwFor.indexOf(_formIds[i]) > -1) {
                    throw new Error('Validator::getFormById(...) exception: could not retrieve form `' + _formIds[i] + '`');
                }
                $formToDestroy.destroy();
                destroyed.push(_formIds[i]);
            } catch (destroyErr) {
                warned.push(_formIds[i]);
            }
        }
    }
    return { destroyed: destroyed, leftInArray: $popinForms, warned: warned };
}

/** The ORIGINAL (defective) loop, kept so the tests prove the replica can observe the bug. */
function teardownOriginal(formIds, registry) {
    var destroyed = [];
    var $popinForms = formIds.slice();
    if (registry) {
        var i = 0, formsLength = $popinForms.length;
        if (formsLength > 0) {
            for (; i < formsLength; ++i) {
                if (typeof (registry[$popinForms[i]]) != 'undefined') {
                    registry[$popinForms[i]].destroy();
                    destroyed.push($popinForms[i]);
                }
                $popinForms.splice(i, 1);
            }
        }
    }
    return { destroyed: destroyed, leftInArray: $popinForms };
}

function makeRegistry(ids) {
    var reg = {};
    ids.forEach(function (id) { reg[id] = { destroy: function () {} }; });
    return reg;
}

// ── 01 — the defect the fix removes (control: the OLD loop must skip) ─────────

describe('01 - #B265 control: the original loop skips odd-indexed forms', function () {

    it('two forms: the original loop destroys only the first', function () {
        var out = teardownOriginal(['A', 'B'], makeRegistry(['A', 'B']));
        assert.deepEqual(out.destroyed, ['A'], 'expected the original loop to skip B');
        assert.deepEqual(out.leftInArray, ['B'], 'expected B left behind in $popin[$forms]');
    });

    it('four forms: the original loop destroys only the originally even indices', function () {
        var out = teardownOriginal(['A', 'B', 'C', 'D'], makeRegistry(['A', 'B', 'C', 'D']));
        assert.deepEqual(out.destroyed, ['A', 'C']);
        assert.deepEqual(out.leftInArray, ['B', 'D']);
    });
});

// ── 02 — the fixed loop (behavioural) ────────────────────────────────────────

describe('02 - #B265 fixed teardown destroys every tracked form', function () {

    [1, 2, 3, 4, 5].forEach(function (n) {
        it(n + ' form(s): all destroyed and the array is emptied', function () {
            var ids = ['A', 'B', 'C', 'D', 'E'].slice(0, n);
            var out = teardownReplica(ids, makeRegistry(ids));
            assert.deepEqual(out.destroyed, ids, 'every form must be destroyed');
            assert.deepEqual(out.leftInArray, [], '$popin[$forms] must be emptied');
        });
    });

    it('an id with no registry entry is skipped without disturbing the others', function () {
        var out = teardownReplica(['A', 'GONE', 'C'], makeRegistry(['A', 'C']));
        assert.deepEqual(out.destroyed, ['A', 'C']);
        assert.deepEqual(out.leftInArray, []);
    });

    it('a null registry is a no-op and leaves the array untouched', function () {
        var out = teardownReplica(['A', 'B'], null);
        assert.deepEqual(out.destroyed, []);
        assert.deepEqual(out.leftInArray, ['A', 'B']);
    });
});

// ── 03 — fault tolerance: one throwing form must not abort the teardown ──────

describe('03 - #B265 a throwing destroy() does not abort the rest of the teardown', function () {

    it('a throw on the FIRST form still destroys the remaining ones', function () {
        var ids = ['A', 'B', 'C'];
        var out = teardownReplica(ids, makeRegistry(ids), ['A']);
        assert.deepEqual(out.warned, ['A']);
        assert.deepEqual(out.destroyed, ['B', 'C'], 'B and C must still be torn down');
        assert.deepEqual(out.leftInArray, []);
    });

    it('a throw on a MIDDLE form still destroys the ones after it', function () {
        var ids = ['A', 'B', 'C'];
        var out = teardownReplica(ids, makeRegistry(ids), ['B']);
        assert.deepEqual(out.warned, ['B']);
        assert.deepEqual(out.destroyed, ['A', 'C']);
    });

    it('every form throwing still empties the array', function () {
        var ids = ['A', 'B'];
        var out = teardownReplica(ids, makeRegistry(ids), ['A', 'B']);
        assert.deepEqual(out.destroyed, []);
        assert.deepEqual(out.warned, ['A', 'B']);
        assert.deepEqual(out.leftInArray, []);
    });
});

// ── 04 — source pins (lock popin/main.js to the replica above) ───────────────

describe('04 - #B265 source pins on popin/main.js', function () {

    it('the teardown no longer splices $popin[$forms] inside the loop', function () {
        assert.ok(
            !/\$popin\['\$forms'\]\.splice\(/.test(getPopinSrc()),
            'expected no `$popin[\'$forms\'].splice(` in popin/main.js — the #B265 defect'
        );
    });

    it('the teardown iterates a copy via .slice()', function () {
        assert.ok(
            /var\s+_formIds\s*=\s*\$popin\['\$forms'\]\.slice\(\)/.test(getPopinSrc()),
            'expected the teardown to snapshot $popin[$forms] with .slice()'
        );
    });

    it('the array is cleared once via .length = 0', function () {
        assert.ok(
            /\$popin\['\$forms'\]\.length\s*=\s*0/.test(getPopinSrc()),
            'expected `$popin[\'$forms\'].length = 0` — the single clear'
        );
    });

    it('each destroy() call is wrapped so one form cannot abort the teardown', function () {
        var src = getPopinSrc();
        var idx = src.indexOf('$formToDestroy.destroy()');
        assert.ok(idx > -1, 'expected the guarded `$formToDestroy.destroy()` call');
        // the try must open before the call and the catch must follow it
        var before = src.slice(Math.max(0, idx - 400), idx);
        var after = src.slice(idx, idx + 400);
        assert.ok(/try\s*\{/.test(before), 'expected a `try {` immediately before destroy()');
        assert.ok(/catch\s*\(\s*destroyErr\s*\)/.test(after), 'expected `catch (destroyErr)` after destroy()');
    });

    it('the cached-length form of the loop is gone', function () {
        assert.ok(
            !/formsLength\s*=\s*\$popin\['\$forms'\]\.length/.test(getPopinSrc()),
            'expected the pre-loop cached length to be gone — it was the skip mechanism'
        );
    });
});
