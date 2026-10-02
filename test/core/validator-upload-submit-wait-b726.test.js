'use strict';
/**
 * #B726 (gh#83 part 3) — a submit waits for its form's staged uploads.
 *
 * Before the fix a validator-bound form could be submitted while one of its staged uploads was
 * still on the wire, and the submit posted the upload's hidden metadata fields EMPTY. Now both
 * submit doors check for an upload in flight before collecting the payload; when one is, the
 * submit records a wait, keeps the busy state, announces `uploadPending`, and is replayed through
 * the same door once the last upload settles — or cancelled, with the busy state released, when
 * an upload fails or the form leaves the page.
 *
 * The behaviour is driven end-to-end on the real bundle by
 * `test/e2e/validator-upload-submit-wait-b726.spec.js`. This file pins the STRUCTURE that
 * behaviour depends on, and that a refactor could silently undo:
 *  - the signal is the virtual upload form's `sent` (set after `xhr.send()`), never `isSending`
 *    (claimed before the request opens, and stuck true when something throws before it leaves);
 *  - both doors hold BEFORE their payload collector, and door B only after cancelling the native
 *    submit (an earlier return would let the browser post the form itself);
 *  - `onUpload` notes every outcome BEFORE the code that can throw, and the decision is deferred
 *    to a microtask;
 *  - the label is project-overridable; `unbindForm` drops a pending wait;
 *  - the built bundles carry the change (dist pins: RED before the rebuild, green after).
 *
 * The cancel path's ownership-gated release is pinned in `test/lib/loading-state.test.js` §06 (f).
 *
 * Red-first: `GINA_B726_MAIN=<file>` points the source pins at another copy of the validator
 * source, e.g. `git show HEAD:<path>` before the change — every source pin must fail there.
 *
 * Usage: node --test test/core/validator-upload-submit-wait-b726.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var MAIN     = process.env.GINA_B726_MAIN || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
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
 * Extracts a `var <name> = function (...) {...}` expression by brace-walking from its
 * declaration, after checking the declaration occurs exactly once.
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
 * Index of `needle` in `src`, asserting it occurs exactly once.
 *
 * @param {string} src
 * @param {string} needle
 * @returns {number}
 */
function uniqueIndex(src, needle) {
    var at = src.indexOf(needle);
    assert.ok(at >= 0, 'not found: ' + needle);
    assert.equal(src.indexOf(needle, at + 1), -1, 'must occur exactly once: ' + needle);
    return at;
}

var HELPERS = {
    inFlight : 'var getStagedUploadsInFlight = function($formEl) {',
    hold     : 'var holdSubmitForStagedUploads = function($formEl, replay) {',
    note     : 'var noteStagedUploadSettled = function($formEl, status) {',
    resolve  : 'var resolveStagedUploadWait = function($formEl) {'
};

describe('#B726 §01 — the four helpers exist, each declared once', function () {

    Object.keys(HELPERS).forEach(function (key) {
        it('extraction control: ' + key + ' walks to a balanced, sane body', function () {
            var fnText = extractFunctionExpression(SRC, HELPERS[key]);
            assert.ok(fnText.length > 150 && fnText.length < 4000, 'sane extraction size: ' + fnText.length);
        });
    });
});

describe('#B726 §02 — the in-flight signal is the upload form\'s `sent`, never `isSending`', function () {

    it('reads data-gina-form-virtual and the virtual record\'s `sent`', function () {
        var body = stripComments(extractFunctionExpression(SRC, HELPERS.inFlight));
        assert.ok(body.indexOf("getAttribute('data-gina-form-virtual')") > -1, 'virtual-form association missing');
        assert.match(body, /\/\^true\$\/i\.test\(instance\.\$forms\[virtualId\]\.sent\)/, 'must test `sent`');
        assert.ok(body.indexOf('$formEl.elements') > -1, 'must walk form.elements (covers form= reassociation)');
    });

    it('never consults isSending (it sticks true when a staging send throws before it leaves)', function () {
        var body = stripComments(extractFunctionExpression(SRC, HELPERS.inFlight));
        assert.equal(body.indexOf('isSending'), -1);
        // anti-vacuity: the stripped body is the real one, not an empty extraction
        assert.ok(body.indexOf('inFlight.push(virtualId)') > -1);
    });
});

describe('#B726 §03 — door A (the click on a bound trigger) holds before its collector and latch', function () {

    it('the hold sits after the #B332 belt and before getFormValidationInfos and the latch', function () {
        var belt    = uniqueIndex(SRC, "var _latchFormId = $target.getAttribute('id');");
        var hold    = uniqueIndex(SRC, 'function replayStagedUploadClick()');
        var collect = uniqueIndex(SRC, 'var validatorInfos = getFormValidationInfos($target, rules);');
        var latch   = SRC.indexOf('instance.$forms[id].isSubmitting = true;', belt);
        assert.ok(latch > -1, 'the latch after the belt was not found');
        assert.ok(belt < hold, 'the hold must follow the belt');
        assert.ok(hold < collect, 'the hold must precede the payload collection');
        assert.ok(hold < latch, 'the hold must precede the latch, so nothing needs releasing');
    });

    it('the replay re-dispatches the same stage-2 event on the bound trigger (re-collects)', function () {
        assert.ok(SRC.indexOf('if ( holdSubmitForStagedUploads($target, function replayStagedUploadClick() { triggerEvent(gina, $submit, evt); }) ) {') > -1);
    });
});

describe('#B726 §04 — door B (the native submit proxy) holds after cancelling the native submit, before its collector', function () {

    it('the hold sits after cancelEvent(e) and before the inline collector', function () {
        var cancel  = uniqueIndex(SRC, '            if (withRules || isBinded) {\n                cancelEvent(e);\n            }');
        var hold    = uniqueIndex(SRC, 'function replayStagedUploadSubmit()');
        var collect = uniqueIndex(SRC, '// just collect data over forms');
        assert.ok(cancel < hold, 'returning before cancelEvent would let the browser post the form');
        assert.ok(hold < collect, 'the hold must precede the payload collection');
    });

    it('is gated on a bound/ruled form and replays through the same native-submit door', function () {
        assert.ok(SRC.indexOf("if ( (withRules || isBinded) && holdSubmitForStagedUploads($target, function replayStagedUploadSubmit() { triggerEvent(gina, $target, 'submit'); }) ) {") > -1);
    });
});

describe('#B726 §05 — onUpload notes every outcome before it handles the error or the success', function () {

    it('the note follows the dropzone idle line and precedes the error branch', function () {
        // #B731 removed the no-error-slot throw this pin used to anchor on (approved by Martin,
        // 2026-10-02); the property kept is that the note runs before any error or success
        // handling. Comments are stripped, so the fix's own `// was:` lines cannot stand in for code.
        var onUpload = stripComments(extractFunctionExpression(SRC, 'var onUpload = function(gina, $target, status, id, data) {'));
        var idle   = onUpload.indexOf("updateUploadDropzoneState(uploadProperties.dropzoneContainer || null, 'idle');");
        var note   = onUpload.indexOf('noteStagedUploadSettled(uploadProperties.$form, status);');
        var branch = onUpload.indexOf("if ($error && status != 'success')");
        assert.ok(idle > -1 && note > -1 && branch > -1, 'anchors: idle ' + idle + ', note ' + note + ', branch ' + branch);
        assert.ok(idle < note, 'the note follows the dropzone finalize');
        assert.ok(note < branch, 'the note must run before the error or success handling');
    });
});

describe('#B726 §06 — the decision is deferred to a microtask, and a failure cancels', function () {

    it('noteStagedUploadSettled marks failures and defers the decision', function () {
        var body = extractFunctionExpression(SRC, HELPERS.note);
        assert.match(body, /if \( status != 'success' \) \{\s*\$formRecord\.stagedUploadWait\.failed = true;/);
        assert.ok(body.indexOf('queueMicrotask(decide)') > -1, 'microtask deferral missing');
        assert.ok(body.indexOf('Promise.resolve().then(decide)') > -1, 'fallback deferral missing');
    });

    it('resolveStagedUploadWait keeps waiting while an upload is in flight, then cancels or replays', function () {
        var body = stripComments(extractFunctionExpression(SRC, HELPERS.resolve));
        var waitCheck = body.indexOf('getStagedUploadsInFlight($formEl).length > 0');
        var clear     = body.indexOf('$formRecord.stagedUploadWait = null;');
        var cancel    = body.indexOf('if ( wait.failed || isDetached ) {');
        var replay    = body.indexOf('wait.replay();');
        assert.ok(waitCheck > -1 && clear > -1 && cancel > -1 && replay > -1, [waitCheck, clear, cancel, replay].join(','));
        assert.ok(waitCheck < clear, 'the in-flight check comes before the wait is cleared');
        assert.ok(clear < cancel && cancel < replay, 'clear, then the cancel branch, then the replay');
    });
});

describe('#B726 §07 — the announcement is a project-overridable label', function () {

    it('uploadPending lives in A11Y_LABELS and is resolved through a11yLabel()', function () {
        var start = SRC.indexOf('var A11Y_LABELS = {');
        var end   = SRC.indexOf('};', start);
        assert.ok(start > -1 && end > start);
        assert.match(SRC.substring(start, end), /uploadPending\s*:\s*'Waiting for the upload to finish/);
        var hold = extractFunctionExpression(SRC, HELPERS.hold);
        assert.ok(hold.indexOf("announceA11yStatus($formEl, a11yLabel('uploadPending'));") > -1);
    });
});

describe('#B726 §08 — unbindForm drops a pending wait', function () {

    it('the wait is cleared before the form is marked unbound', function () {
        var unbind = extractFunctionExpression(SRC, 'var unbindForm = function($target) {');
        var clear  = unbind.indexOf('$form.stagedUploadWait = null;');
        var unbound = unbind.indexOf('$form.binded = false;');
        assert.ok(clear > -1 && unbound > -1 && clear < unbound);
    });
});

describe('#B726 §09 — the built bundles carry the change (RED before the rebuild)', function () {

    it('both artifacts carry the label text and the wait property', function () {
        var distJs  = fs.readFileSync(DIST, 'utf8');
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        ['Waiting for the upload to finish', 'stagedUploadWait'].forEach(function (s) {
            assert.ok(distJs.indexOf(s) > -1, 'gina.js missing: ' + s);
            assert.ok(distMin.indexOf(s) > -1, 'gina.min.js missing: ' + s);
        });
        // instrument control: a literal that exists nowhere must read absent
        assert.equal(distMin.indexOf('zzz-b726-never-shipped'), -1);
    });
});
