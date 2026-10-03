/**
 * #A11Y7 — staged-upload accessibility: progress semantics (U2), error
 * announcement (U3) and a real reset control (U5).
 *
 * Scope of the three findings, as measured against the shipped source:
 *  - U2: `updateUploadProgressIndicator` wrote `textContent` + two data
 *    attributes and NO ARIA, so any non-`<progress>` indicator was unlabelled
 *    text to assistive tech; and nothing announced that an upload had begun or
 *    finished.
 *  - U3: the upload error container is written via `innerHTML` while
 *    `display:none` and only revealed by a fade-in — the case where a
 *    `role="alert"` on it is unreliable — and gina's own polite live region,
 *    which validation errors already use, was never called.
 *  - U5: the reset control is generated as `<a href="#">Reset</a>` — announced
 *    as a link, not activatable with Space, identical across every staged file
 *    — and it is removed from the DOM while holding focus, dropping focus to
 *    `<body>` silently.
 *
 * Strategy:
 *  - The indicator helper is EXTRACTED from the shipped source at run time
 *    (brace-walk, control-gated) and executed against a jsdom document, so the
 *    ARIA assertions drive the exact shipped bytes rather than a replica.
 *  - Source-inspection pins lock the shapes that cannot be driven here: the
 *    announcement call sites, the button semantics, the Space handler, and the
 *    focus-before-removal ORDER (the property the whole U5 fix rests on).
 *  - Dist-fidelity pins assert the built bundles carry the new string literals.
 *    They are red before the rebuild and green after — that transition is the
 *    subtract control proving they detect a stale artifact.
 *
 * Usage: node --test test/core/validator-upload-a11y.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { JSDOM } = require('jsdom');

var FW       = require('../fw');
var MAIN     = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC;

before(function () {
    SRC = fs.readFileSync(MAIN, 'utf8');
});

/**
 * Strips block comments then line comments, for negative pins that must not
 * trip on prose mentions — the own-JSDoc trap. The U3 rationale comment names
 * `role="alert"` precisely to explain why it is NOT used, which reads as a hit
 * to a naive negative pin.
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
 * Extracts a `var <name> = function (...) {...}` function expression from the
 * source by brace-walking from its declaration.
 *
 * @param {string} src
 * @param {string} declaration - the exact declaration prefix to anchor on
 * @returns {string} the function text, `function` through its matching brace
 */
function extractFunctionExpression(src, declaration) {
    var declIdx = src.indexOf(declaration);
    assert.ok(declIdx >= 0, 'declaration not found: ' + declaration);
    assert.equal(src.indexOf(declaration, declIdx + 1), -1,
        'declaration must occur exactly once: ' + declaration);
    var fnStart  = src.indexOf('function', declIdx);
    var braceIdx = src.indexOf('{', fnStart);
    var depth    = 0;
    for (var i = braceIdx, len = src.length; i < len; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.substring(fnStart, i + 1);
        }
    }
    assert.fail('unbalanced braces walking ' + declaration);
}

/**
 * Builds a jsdom document with one native `<progress>` and one plain element,
 * and returns the extracted indicator bound to it.
 *
 * @returns {object} `{ fn, doc }`
 */
function indicatorHarness() {
    var dom = new JSDOM('<!doctype html><html><body>' +
        '<progress id="native"></progress>' +
        '<div id="text"></div>' +
        '</body></html>');
    var fnText = extractFunctionExpression(SRC, 'var updateUploadProgressIndicator = function');
    var make   = new Function('document', 'return (' + fnText + ');');
    return { fn: make(dom.window.document), doc: dom.window.document };
}

// ─── §01 — U2: the indicator carries progressbar semantics ──────────────────
describe('#A11Y7/U2 §01 — non-native indicator gets progressbar semantics (shipped bytes, jsdom)', function () {

    it('01 - `uploading` sets role + bounds + a matching aria-valuenow', function () {
        var h = indicatorHarness();
        h.fn('text', 'uploading', { progress: 42, loaded: 42, total: 100 });
        var $t = h.doc.getElementById('text');
        assert.equal($t.getAttribute('role'), 'progressbar');
        assert.equal($t.getAttribute('aria-valuemin'), '0');
        assert.equal($t.getAttribute('aria-valuemax'), '100');
        assert.equal($t.getAttribute('aria-valuenow'), '42');
        // the visible text is unchanged by the a11y work
        assert.equal($t.textContent, '42%');
    });

    it('02 - `complete` reports 100', function () {
        var h = indicatorHarness();
        h.fn('text', 'complete');
        assert.equal(h.doc.getElementById('text').getAttribute('aria-valuenow'), '100');
    });

    it('03 - `preparing` is INDETERMINATE: role present, aria-valuenow ABSENT', function () {
        var h = indicatorHarness();
        h.fn('text', 'preparing');
        var $t = h.doc.getElementById('text');
        assert.equal($t.getAttribute('role'), 'progressbar');
        assert.equal($t.hasAttribute('aria-valuenow'), false,
            'an absent aria-valuenow IS the indeterminate signal');
    });

    it('04 - `indeterminate` drops a previously-set aria-valuenow (no stale value)', function () {
        var h = indicatorHarness();
        h.fn('text', 'uploading', { progress: 60, loaded: 60, total: 100 });
        assert.equal(h.doc.getElementById('text').getAttribute('aria-valuenow'), '60');
        h.fn('text', 'indeterminate');
        assert.equal(h.doc.getElementById('text').hasAttribute('aria-valuenow'), false,
            'a stale value would read as real, stalled progress');
    });

    it('05 - `error` empties rather than reporting a confident 0%', function () {
        var h = indicatorHarness();
        h.fn('text', 'uploading', { progress: 70, loaded: 70, total: 100 });
        h.fn('text', 'error');
        var $t = h.doc.getElementById('text');
        assert.equal($t.hasAttribute('aria-valuenow'), false);
        assert.equal($t.getAttribute('data-gina-upload-progress-state'), 'error');
    });

    it('06 - `reset` strips the ARIA too, not just the data attributes', function () {
        var h = indicatorHarness();
        h.fn('text', 'uploading', { progress: 30, loaded: 30, total: 100 });
        h.fn('text', 'reset');
        var $t = h.doc.getElementById('text');
        ['role', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow'].forEach(function (a) {
            assert.equal($t.hasAttribute(a), false, a + ' must not survive a reset');
        });
    });

    it('07 - `processing` preserves the last known value (byte-complete, server working)', function () {
        var h = indicatorHarness();
        h.fn('text', 'uploading', { progress: 100, loaded: 100, total: 100 });
        h.fn('text', 'processing');
        var $t = h.doc.getElementById('text');
        assert.equal($t.getAttribute('aria-valuenow'), '100',
            'processing advances the STATE only');
        assert.equal($t.getAttribute('data-gina-upload-progress-state'), 'processing');
    });

    it('08 - a native <progress> is left ALONE (it already has implicit semantics)', function () {
        var h = indicatorHarness();
        h.fn('native', 'uploading', { progress: 42, loaded: 42, total: 100 });
        var $n = h.doc.getElementById('native');
        assert.equal($n.hasAttribute('role'), false,
            'an explicit role would override the implicit one');
        assert.equal($n.hasAttribute('aria-valuenow'), false);
        assert.equal($n.hasAttribute('aria-valuemin'), false);
        // …while its native properties still track the upload
        assert.equal($n.getAttribute('data-gina-upload-progress'), '42');
    });

    it('09 - CONTROL: a missing target is still a silent no-op', function () {
        var h = indicatorHarness();
        assert.doesNotThrow(function () { h.fn('nope', 'uploading', { progress: 1, loaded: 1, total: 100 }); });
        assert.doesNotThrow(function () { h.fn(null, 'uploading', { progress: 1, loaded: 1, total: 100 }); });
    });
});

// ─── §02 — U2: the transitions are announced, and only the transitions ──────
describe('#A11Y7/U2 §02 — start and completion are announced (source pins)', function () {

    it('01 - the label table carries the two upload keys', function () {
        assert.match(SRC, /uploadStarted\s*:\s*'Upload started'/);
        assert.match(SRC, /uploadComplete\s*:\s*'Upload complete'/);
    });

    it('02 - start is announced on the real owning form, not the virtual upload form', function () {
        assert.match(SRC,
            /announceA11yStatus\(\s*\$a11yUploadInput\.form,\s*a11yLabel\('uploadStarted'\)\s*\)/,
            'the region lives on the input\'s own form so upload status and validation errors share it');
    });

    it('03 - the start announcement is NOT gated on the progress container', function () {
        // the indicator is opt-in by presence; the announcement must not inherit that
        var kickoff = SRC.indexOf("updateUploadProgressIndicator($uploadForm.uploadProperties.progressContainer, 'preparing')");
        var announce = SRC.indexOf("a11yLabel('uploadStarted')");
        assert.ok(kickoff > -1 && announce > -1);
        assert.ok(announce > kickoff, 'announcement follows the kickoff block');
        // it sits in its own `if`, keyed on the trigger id rather than the container
        assert.match(SRC,
            /if \( \$uploadForm\.uploadProperties && \$uploadForm\.uploadProperties\.uploadTriggerId \)/);
    });

    it('04 - completion is announced in the SUCCESS branch only', function () {
        assert.match(SRC,
            /announceA11yStatus\(\$uploadTriger\.form, a11yLabel\('uploadComplete'\)\)/);
    });

    it('05 - there is deliberately NO generic upload-error label', function () {
        // a generic "failed" written after U3's specific message would clobber it:
        // the polite region is latest-wins
        assert.ok(SRC.indexOf("uploadError   ") < 0);
        assert.doesNotMatch(SRC, /uploadError\s*:\s*'/);
    });

    it('06 - progress is never announced per tick', function () {
        // no announcement inside the determinate/onprogress path
        var fnText = extractFunctionExpression(SRC, 'var updateUploadProgressIndicator = function');
        assert.ok(fnText.indexOf('announceA11y') < 0,
            'the indicator helper must not announce — it runs on every onprogress event');
    });
});

// ─── §03 — U3: the upload error reaches the live region ─────────────────────
describe('#A11Y7/U3 §03 — upload errors are announced through the polite region (source pins)', function () {

    it('01 - the error branch announces via announceA11yError', function () {
        assert.match(SRC,
            /announceA11yError\(\$uploadTriger\.form, \$error\.textContent\)/,
            'announce the RENDERED text: the message may carry markup');
    });

    it('02 - the announcement follows the innerHTML write and the reveal', function () {
        // #B727 — the write is now createElement + textContent + appendChild (the
        // error message is rendered as TEXT, never HTML); re-anchored off the removed
        // `$error.innerHTML = …` literal. The order (write → reveal → announce) is the
        // invariant and is unchanged.
        var write    = SRC.indexOf('$error.appendChild(_errP)');
        var reveal   = SRC.indexOf('fadeIn($error)');
        var announce = SRC.indexOf('announceA11yError($uploadTriger.form, $error.textContent)');
        assert.ok(write > -1 && reveal > -1 && announce > -1);
        assert.ok(write < reveal && reveal < announce,
            'textContent is only complete after the write');
    });

    it('03 - no role="alert" was stamped on the consumer-owned container', function () {
        // the container is display:none when written and revealed by a fade-in —
        // the case where role=alert is unreliable; the live region is used instead.
        // Comments MUST be stripped first: the rationale comment at that very site
        // names the attribute in order to explain why it is not used, so a raw pin
        // here fails on its own prose (measured — it did).
        var bare = stripComments(SRC);
        var at   = bare.indexOf('if (uploadProperties.errorField)');
        assert.ok(at > -1, 'anchor still present after comment strip');
        var slice = bare.substring(at, at + 2500);
        assert.ok(slice.indexOf("setAttribute('role', 'alert')") < 0);
        assert.ok(slice.indexOf('role="alert"') < 0);
        // CONTROL: the strip must not have eaten the code the slice should contain
        assert.ok(slice.indexOf('announceA11yError') > -1,
            'the slice still covers the announcement site');
    });
});

// ─── §04 — U5: a real button, and focus survives the removal ────────────────
describe('#A11Y7/U5 §04 — the generated reset control is operable and keeps focus (source pins)', function () {

    it('01 - the generated anchor is given button semantics', function () {
        assert.match(SRC, /\$resetLink\.setAttribute\('role', 'button'\)/);
    });

    it('02 - the accessible name carries the file, prefixed by the visible label', function () {
        // WCAG 2.5.3 Label in Name: the visible text must be contained in the name
        assert.match(SRC,
            /setAttribute\('aria-label', resetLabel \+ ' ' \+ files\[f\]\.originalFilename\)/);
        assert.match(SRC,
            /let resetLabel = \$uploadTriger\.getAttribute\('data-gina-form-upload-reset-label'\) \|\| 'Reset'/,
            'the name reuses the consumer label, so it is translated wherever that is');
    });

    it('03 - the semantics are stamped on anchors ONLY (a real <button> is left alone)', function () {
        var i = SRC.indexOf("$resetLink.setAttribute('role', 'button')");
        assert.ok(i > -1);
        var guard = SRC.lastIndexOf('/^a$/i.test($resetLink.tagName)', i);
        assert.ok(guard > -1 && guard < i, 'the role stamp sits inside a strict anchor guard');
    });

    it('04 - role="button" is backed by a real Space handler', function () {
        assert.match(SRC, /function onUploadResetOrDeleteTriggerKeydown\(e\) \{/);
        assert.match(SRC, /if \( e\.key === ' ' \|\| e\.keyCode === 32 \)/);
        // …bound only on anchors, or a native button would fire the removal twice
        var kd = SRC.indexOf('onUploadResetOrDeleteTriggerKeydown');
        var guard = SRC.lastIndexOf('/^a$/i.test($uploadResetOrDeleteTrigger.tagName)', kd);
        assert.ok(guard > -1 && guard < kd);
    });

    it('05 - the Space handler preventDefaults (Space would scroll the page)', function () {
        var fnIdx = SRC.indexOf('function onUploadResetOrDeleteTriggerKeydown');
        var slice = SRC.substring(fnIdx, fnIdx + 400);
        assert.ok(slice.indexOf('e.preventDefault()') > -1);
        assert.ok(slice.indexOf('onUploadResetOrDelete($uploadTrigger, bindingType)') > -1);
    });

    it('06 - focus is moved BEFORE the node is removed (the load-bearing order)', function () {
        var focus  = SRC.indexOf('$uploadTrigger.focus();');
        var remove = SRC.indexOf('$resetLink.remove();');
        assert.ok(focus > -1 && remove > -1);
        assert.ok(focus < remove,
            'removing a focused element drops focus to <body>; the move must precede it');
    });

    it('07 - the focus move is guarded on the control actually holding focus', function () {
        assert.match(SRC,
            /if \( document\.activeElement === \$resetLink \|\| \$resetLink\.contains\(document\.activeElement\) \)/,
            'a programmatic reset must not steal focus from elsewhere');
    });

    it('08 - the move is CONFIRMED, not assumed (focus() is a silent no-op on many elements)', function () {
        assert.match(SRC, /if \( document\.activeElement !== \$uploadTrigger \) \{/);
    });

    it('09 - the removal is announced, with a FUNCTION replacer for the file name', function () {
        // a file name may contain `$`; a string replacement would expand $& / $1
        assert.match(SRC,
            /a11yLabel\('fileRemoved'\)\.replace\('%s', function \(\) \{ return childNodeFile; \}\)/);
        assert.match(SRC, /fileRemoved\s*:\s*'%s removed'/);
    });

    it('10 - the announcement also precedes the removal', function () {
        var announce = SRC.indexOf("a11yLabel('fileRemoved')");
        var remove   = SRC.indexOf('$resetLink.remove();');
        assert.ok(announce > -1 && announce < remove);
    });
});

// ─── §05 — the labels stay overridable ──────────────────────────────────────
describe('#A11Y7 §05 — the new strings are project-overridable', function () {

    it('01 - all three new keys live in A11Y_LABELS, so gina.config.a11y overrides them', function () {
        var start = SRC.indexOf('var A11Y_LABELS = {');
        var end   = SRC.indexOf('};', start);
        assert.ok(start > -1 && end > start);
        var table = SRC.substring(start, end);
        ['uploadStarted', 'uploadComplete', 'fileRemoved'].forEach(function (k) {
            assert.ok(table.indexOf(k) > -1, k + ' must be in the overridable table');
        });
        // and the pre-existing key is untouched
        assert.ok(table.indexOf('submitting') > -1);
    });

    it('02 - every new announcement goes through a11yLabel(), never a literal', function () {
        ['uploadStarted', 'uploadComplete', 'fileRemoved'].forEach(function (k) {
            assert.ok(SRC.indexOf("a11yLabel('" + k + "')") > -1,
                k + ' must be resolved through a11yLabel so an override applies');
        });
    });
});

// ─── §06 — the built bundles carry it ───────────────────────────────────────
describe('#A11Y7 §06 — built bundles carry the fix (dist pins)', function () {

    it('01 - the new label literals are in BOTH artifacts', function () {
        var distJs  = fs.readFileSync(DIST, 'utf8');
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        ['Upload started', 'Upload complete', '%s removed'].forEach(function (s) {
            assert.ok(distJs.indexOf(s) > -1, 'gina.js missing: ' + s);
            assert.ok(distMin.indexOf(s) > -1, 'gina.min.js missing: ' + s);
        });
    });

    it('02 - the progressbar semantics survive minification', function () {
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        // string literals survive Closure SIMPLE; single-quoted in source, so
        // anchor on the VALUE, never on a quote style (a double-quoted needle
        // here reads 0 with its control also 0 — an unvalidated instrument)
        assert.ok(distMin.indexOf('progressbar') > -1);
        assert.ok(distMin.indexOf('aria-valuenow') > -1);
        assert.ok(distMin.indexOf('aria-valuemin') > -1);
        assert.ok(distMin.indexOf('aria-valuemax') > -1);
    });

    it('03 - all five aria-valuenow sites survive (set/remove across every state)', function () {
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        var count = distMin.split('aria-valuenow').length - 1;
        assert.equal(count, 5,
            'reset/complete/error/indeterminate/determinate — one site each');
    });

    it('04 - the button semantics reached the bundle', function () {
        var distMin = fs.readFileSync(DIST_MIN, 'utf8');
        assert.ok(distMin.indexOf('aria-label') > -1);
        assert.ok(distMin.indexOf('button') > -1);
    });
});
